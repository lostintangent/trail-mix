import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { LOGO_BYTES, RECHECK_MS } from '../core/avatars.ts';
import { logoCache, logoNetwork, lookUpLogo, type LogoNetwork } from './logos.ts';
import { testSql } from './test-sql.ts';

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;
const LOGO = '<svg xmlns="http://www.w3.org/2000/svg"><rect width="8" height="8"/></svg>';

describe('the Logo cache', () => {
  test('owes a lookup when verified mail from a domain arrives, once however much arrives', () => {
    const cache = logoCache(testSql());
    cache.note(['brand.example', 'shop.example'], 0);
    cache.note(['brand.example'], 5);

    expect(cache.owed(10, 8)).toEqual(['brand.example', 'shop.example']);
    expect(cache.owed(10, 1)).toEqual(['brand.example']);
    expect(cache.owed(-1, 8)).toEqual([]);
  });

  test('keeps a logo found, and says so', () => {
    const cache = logoCache(testSql());
    cache.note(['brand.example'], 0);

    expect(cache.found('brand.example', LOGO, 1)).toBe(true);
    expect(cache.logo('brand.example')).toBe(LOGO);
    expect(cache.held(['brand.example', 'shop.example'])).toEqual(new Set(['brand.example']));
    expect(cache.owed(2, 8)).toEqual([]);
    // Found again unchanged, nothing came or went.
    expect(cache.found('brand.example', LOGO, 2)).toBe(false);
  });

  test('looks a logo it holds up again each week, and lets it go when the domain stops enforcing', () => {
    const cache = logoCache(testSql());
    cache.note(['brand.example'], 0);
    cache.found('brand.example', LOGO, 0);

    expect(cache.owed(RECHECK_MS - 1, 8)).toEqual([]);
    expect(cache.owed(RECHECK_MS, 8)).toEqual(['brand.example']);
    expect(cache.found('brand.example', undefined, RECHECK_MS)).toBe(true);
    expect(cache.logo('brand.example')).toBeUndefined();
    expect(cache.held(['brand.example'])).toEqual(new Set());
  });

  test('looks a domain without a logo up again only when its mail comes a week or more on', () => {
    const cache = logoCache(testSql());
    cache.note(['plain.example'], 0);
    expect(cache.found('plain.example', undefined, 0)).toBe(false);

    expect(cache.owed(10 * RECHECK_MS, 8)).toEqual([]);
    cache.note(['plain.example'], DAY);
    expect(cache.owed(RECHECK_MS - 1, 8)).toEqual([]);
    expect(cache.owed(RECHECK_MS, 8)).toEqual(['plain.example']);

    // A logo it finds then comes, as one found after its mail arrived does.
    expect(cache.found('plain.example', LOGO, RECHECK_MS)).toBe(true);
  });

  test('tries a lookup that couldn’t finish again in an hour, keeping the logo it had', () => {
    const cache = logoCache(testSql());
    cache.note(['brand.example'], 0);
    cache.found('brand.example', LOGO, 0);
    cache.failed('brand.example', RECHECK_MS);

    expect(cache.logo('brand.example')).toBe(LOGO);
    expect(cache.owed(RECHECK_MS + HOUR - 1, 8)).toEqual([]);
    expect(cache.owed(RECHECK_MS + HOUR, 8)).toEqual(['brand.example']);
  });

  test('forgets every domain but those still sending the member’s mail', () => {
    const cache = logoCache(testSql());
    cache.note(['brand.example', 'gone.example'], 0);
    cache.found('brand.example', LOGO, 0);
    cache.found('gone.example', LOGO, 0);
    cache.keep(new Set(['brand.example']));

    expect(cache.logo('gone.example')).toBeUndefined();
    expect(cache.logo('brand.example')).toBe(LOGO);
    // A lookup that ends after its domain went keeps nothing.
    expect(cache.found('gone.example', LOGO, 1)).toBe(false);
    expect(cache.logo('gone.example')).toBeUndefined();
  });
});

/** DNS and the logos' hosts as a test sets them, recording what was asked. */
function network(txt: Record<string, string[]>, svgs: Record<string, string> = {}) {
  const asked: string[] = [];
  const net: LogoNetwork = {
    txt: (name) => {
      asked.push(name);
      return Promise.resolve(txt[name] ?? []);
    },
    svg: (location) => {
      asked.push(location);
      return Promise.resolve(svgs[location]);
    },
  };
  return { net, asked };
}

const BIMI = 'v=BIMI1; l=https://cdn.brand.example/logo.svg';

describe('looking a logo up', () => {
  test('finds the SVG a domain’s BIMI record names while its DMARC policy enforces', async () => {
    const { net } = network(
      { '_dmarc.brand.example': ['v=DMARC1; p=reject'], 'default._bimi.brand.example': [BIMI] },
      { 'https://cdn.brand.example/logo.svg': LOGO },
    );
    expect(await lookUpLogo('brand.example', net)).toBe(LOGO);
  });

  test('finds none, and fetches nothing, for a domain whose policy is none', async () => {
    const { net, asked } = network(
      { '_dmarc.lax.example': ['v=DMARC1; p=none'], 'default._bimi.lax.example': [BIMI] },
      { 'https://cdn.brand.example/logo.svg': LOGO },
    );
    expect(await lookUpLogo('lax.example', net)).toBeUndefined();
    expect(asked).toEqual(['_dmarc.lax.example']);
  });

  test('falls back to the organizational domain’s record and policy', async () => {
    const { net } = network(
      {
        '_dmarc.brand.example': ['v=DMARC1; p=reject'],
        'default._bimi.brand.example': [BIMI],
      },
      { 'https://cdn.brand.example/logo.svg': LOGO },
    );
    expect(await lookUpLogo('news.brand.example', net)).toBe(LOGO);
  });

  test('stops at a subdomain that declines a logo of its own', async () => {
    const { net } = network(
      {
        '_dmarc.brand.example': ['v=DMARC1; p=reject'],
        'default._bimi.news.brand.example': ['v=BIMI1; l=;'],
        'default._bimi.brand.example': [BIMI],
      },
      { 'https://cdn.brand.example/logo.svg': LOGO },
    );
    expect(await lookUpLogo('news.brand.example', net)).toBeUndefined();
  });

  test('keeps no logo that is scripted, or that its host didn’t serve within 32 KB', async () => {
    const scripted = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>';
    const dns = {
      '_dmarc.brand.example': ['v=DMARC1; p=quarantine'],
      'default._bimi.brand.example': [BIMI],
    };
    const location = 'https://cdn.brand.example/logo.svg';
    expect(await lookUpLogo('brand.example', network(dns, { [location]: scripted }).net)).toBe(
      undefined,
    );
    expect(await lookUpLogo('brand.example', network(dns).net)).toBeUndefined();
  });

  test('fails when DNS can’t say, so the cache tries again', async () => {
    const net: LogoNetwork = {
      txt: () => Promise.reject(new Error('DNS couldn’t answer.')),
      svg: () => Promise.resolve(LOGO),
    };
    await expect(lookUpLogo('brand.example', net)).rejects.toThrow('DNS couldn’t answer.');
  });
});

describe('the internet, as a lookup reaches it', () => {
  let internet: ReturnType<typeof spyOn<typeof globalThis, 'fetch'>> | undefined;
  afterEach(() => internet?.mockRestore());

  /** Answers each request by its URL, and records them. */
  function answering(routes: Record<string, () => Response>) {
    const asked: string[] = [];
    internet = spyOn(globalThis, 'fetch').mockImplementation(((input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : input.toString();
      asked.push(url);
      return Promise.resolve(routes[url]?.() ?? new Response('', { status: 404 }));
    }) as typeof fetch);
    return asked;
  }

  const dns = (body: object) => () => Response.json(body);
  const RESOLVER = 'https://dns.example/dns-query';
  const asking = (name: string) => `${RESOLVER}?name=${name}&type=TXT`;

  test('reads TXT records from DNS over HTTPS, and none for a name that doesn’t exist', async () => {
    answering({
      [asking('_dmarc.brand.example')]: dns({
        Status: 0,
        Answer: [
          { type: 5, data: 'brand.example.cdn.example.' },
          { type: 16, data: '"v=DMARC1; " "p=reject"' },
        ],
      }),
      [asking('_dmarc.nowhere.example')]: dns({ Status: 3 }),
    });
    const { txt } = logoNetwork(RESOLVER);
    expect(await txt('_dmarc.brand.example')).toEqual(['v=DMARC1; p=reject']);
    expect(await txt('_dmarc.nowhere.example')).toEqual([]);
  });

  test('fails when DNS can’t answer', async () => {
    answering({ [asking('_dmarc.broken.example')]: dns({ Status: 2 }) });
    const { txt } = logoNetwork(RESOLVER);
    await expect(txt('_dmarc.broken.example')).rejects.toThrow();
    await expect(txt('_dmarc.unknown.example')).rejects.toThrow('404');
  });

  test('fetches a logo over HTTPS from a public host, following redirects that stay so', async () => {
    const asked = answering({
      'https://brand.example/logo.svg': () =>
        new Response(null, { status: 301, headers: { location: '/v2/logo.svg' } }),
      'https://brand.example/v2/logo.svg': () => new Response(LOGO),
    });
    expect(await logoNetwork(RESOLVER).svg('https://brand.example/logo.svg')).toBe(LOGO);
    expect(asked).toEqual(['https://brand.example/logo.svg', 'https://brand.example/v2/logo.svg']);
  });

  test('fetches nothing from a plain HTTP or private location, at any hop', async () => {
    const asked = answering({
      'https://brand.example/to-http': () =>
        new Response(null, { status: 302, headers: { location: 'http://brand.example/logo.svg' } }),
      'https://brand.example/to-here': () =>
        new Response(null, { status: 302, headers: { location: 'https://127.0.0.1/logo.svg' } }),
    });
    const { svg } = logoNetwork(RESOLVER);
    for (const location of [
      'http://brand.example/logo.svg',
      'https://localhost/logo.svg',
      'https://10.0.0.8/logo.svg',
      'https://user:secret@brand.example/logo.svg',
      'https://brand.example/to-http',
      'https://brand.example/to-here',
    ]) {
      expect(await svg(location)).toBeUndefined();
    }
    expect(asked).toEqual(['https://brand.example/to-http', 'https://brand.example/to-here']);
  });

  test('a test’s stand-in serves its logos from this machine', async () => {
    answering({ 'https://localhost:4443/logo.svg': () => new Response(LOGO) });
    expect(await logoNetwork(RESOLVER, true).svg('https://localhost:4443/logo.svg')).toBe(LOGO);
  });

  test('reads no further than 32 KB of a logo, whether or not its host says its size', async () => {
    let pulled = 0;
    answering({
      'https://brand.example/declared.svg': () =>
        new Response(LOGO, { headers: { 'content-length': String(LOGO_BYTES + 1) } }),
      'https://brand.example/endless.svg': () =>
        new Response(
          new ReadableStream({
            pull(controller) {
              pulled += 1;
              controller.enqueue(new Uint8Array(1024).fill(32));
            },
          }),
        ),
      'https://brand.example/exact.svg': () => new Response(new Uint8Array(LOGO_BYTES).fill(32)),
    });
    const { svg } = logoNetwork(RESOLVER);
    expect(await svg('https://brand.example/declared.svg')).toBeUndefined();
    expect(await svg('https://brand.example/endless.svg')).toBeUndefined();
    expect(pulled).toBeLessThanOrEqual(LOGO_BYTES / 1024 + 2);
    expect(await svg('https://brand.example/exact.svg')).toHaveLength(LOGO_BYTES);
  });

  test('keeps nothing its host didn’t serve, or that isn’t UTF-8', async () => {
    answering({
      'https://brand.example/latin1.svg': () => new Response(new Uint8Array([0x3c, 0xe9, 0x3e])),
    });
    const { svg } = logoNetwork(RESOLVER);
    expect(await svg('https://brand.example/missing.svg')).toBeUndefined();
    expect(await svg('https://brand.example/latin1.svg')).toBeUndefined();
  });
});
