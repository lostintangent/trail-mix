import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { PICTURE_BYTES, RECHECK_MS, type Picture } from '../core/avatars.ts';
import {
  avatarCache,
  avatarNetwork,
  INTERNET,
  internetSources,
  keyed,
  lookUpDomain,
  type AvatarNetwork,
  type Home,
} from './avatars.ts';
import { upgrade } from './schema.ts';
import { testSql } from './test-sql.ts';

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;
const LOGO = '<svg xmlns="http://www.w3.org/2000/svg"><rect width="8" height="8"/></svg>';
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]);

const svgOf = (svg: string): Picture => ({
  type: 'image/svg+xml',
  bytes: new Uint8Array(new TextEncoder().encode(svg)),
});
/** A distinct PNG for each name, as a test needs pictures that differ. */
const png = (name: string): Picture => ({
  type: 'image/png',
  bytes: new Uint8Array([...PNG, ...new TextEncoder().encode(name)]),
});
const LOGO_PICTURE = await keyed(svgOf(LOGO));
const ICON = await keyed(png('icon'));
const PHOTO = await keyed(png('photo'));

const ADA = 'ada@brand.example';
const BEA = 'bea@brand.example';

describe('the Avatar cache', () => {
  test('owes a lookup for each verified sender and their domain, once however much arrives', () => {
    const cache = avatarCache(testSql());
    cache.note([ADA, 'news@shop.example'], 0);
    cache.note([ADA, BEA], 5);

    expect(cache.owed(10, { domains: 8, senders: 8 })).toEqual({
      domains: ['brand.example', 'shop.example'],
      senders: [ADA, 'news@shop.example', BEA],
    });
    expect(cache.owed(10, { domains: 1, senders: 2 })).toEqual({
      domains: ['brand.example'],
      senders: [ADA, 'news@shop.example'],
    });
    expect(cache.owed(-1, { domains: 8, senders: 8 })).toEqual({ domains: [], senders: [] });
  });

  test('names a sender’s logo, else their photo, else their domain’s icon, by its picture’s key', () => {
    const cache = avatarCache(testSql());
    cache.note([ADA, BEA, 'cy@shop.example', 'dee@plain.example'], 0);
    expect(cache.foundDomain('brand.example', { icon: ICON }, 1)).toBe(true);
    expect(cache.foundSender(ADA, PHOTO, 1)).toBe(true);
    expect(cache.foundDomain('shop.example', { logo: LOGO_PICTURE }, 1)).toBe(true);
    expect(cache.foundSender('cy@shop.example', PHOTO, 1)).toBe(true);
    expect(cache.foundDomain('plain.example', { icon: 'none' }, 1)).toBe(false);

    expect(
      cache.pictures([ADA, BEA, 'cy@shop.example', 'dee@plain.example', 'eve@else.example']),
    ).toEqual(
      new Map([
        [ADA, PHOTO.key],
        [BEA, ICON.key],
        ['cy@shop.example', LOGO_PICTURE.key],
      ]),
    );
    expect(cache.picture(PHOTO.key)).toEqual({ type: 'image/png', bytes: PHOTO.bytes });
    expect(cache.picture(LOGO_PICTURE.key)?.type).toBe('image/svg+xml');
    expect(cache.picture('0'.repeat(64))).toBeUndefined();
    // Found again unchanged, nothing came or went.
    expect(cache.foundSender(ADA, PHOTO, 2)).toBe(false);
  });

  test('keeps a picture’s bytes once however many show it, and lets them go once none does', () => {
    const sql = testSql();
    const cache = avatarCache(sql);
    cache.note([ADA, BEA], 0);
    cache.foundSender(ADA, PHOTO, 0);
    cache.foundSender(BEA, PHOTO, 0);
    expect(sql.all(`SELECT key FROM avatar_pictures`)).toEqual([{ key: PHOTO.key }]);

    cache.foundSender(ADA, undefined, RECHECK_MS);
    expect(cache.picture(PHOTO.key)).toBeDefined();
    cache.foundSender(BEA, undefined, RECHECK_MS);
    expect(cache.picture(PHOTO.key)).toBeUndefined();
    expect(sql.all(`SELECT key FROM avatar_pictures`)).toEqual([]);

    // A domain's icon that changes lets the old one go.
    cache.foundDomain('brand.example', { icon: ICON }, 0);
    expect(cache.foundDomain('brand.example', { icon: PHOTO }, RECHECK_MS)).toBe(true);
    expect(sql.all(`SELECT key FROM avatar_pictures`)).toEqual([{ key: PHOTO.key }]);
  });

  test('looks a picture it holds up again each week, and lets it go when its source does', () => {
    const cache = avatarCache(testSql());
    cache.note([ADA], 0);
    cache.foundDomain('brand.example', { logo: LOGO_PICTURE }, 0);
    cache.foundSender(ADA, PHOTO, 0);

    expect(cache.owed(RECHECK_MS - 1, { domains: 8, senders: 8 })).toEqual({
      domains: [],
      senders: [],
    });
    expect(cache.owed(RECHECK_MS, { domains: 8, senders: 8 })).toEqual({
      domains: ['brand.example'],
      senders: [ADA],
    });
    expect(cache.foundDomain('brand.example', { icon: 'none' }, RECHECK_MS)).toBe(true);
    expect(cache.pictures([ADA])).toEqual(new Map([[ADA, PHOTO.key]]));
    expect(cache.foundSender(ADA, undefined, RECHECK_MS)).toBe(true);
    expect(cache.pictures([ADA])).toEqual(new Map());
  });

  test('looks one without a picture up again only when its mail comes a week or more on', () => {
    const cache = avatarCache(testSql());
    cache.note([ADA], 0);
    cache.foundDomain('brand.example', { icon: 'none' }, 0);
    cache.foundSender(ADA, undefined, 0);
    const owed = (now: number) => cache.owed(now, { domains: 8, senders: 8 });

    expect(owed(10 * RECHECK_MS)).toEqual({ domains: [], senders: [] });
    cache.note([ADA], DAY);
    expect(owed(RECHECK_MS - 1)).toEqual({ domains: [], senders: [] });
    expect(owed(RECHECK_MS)).toEqual({ domains: ['brand.example'], senders: [ADA] });

    // A picture it finds then comes, as one found after its mail arrived does.
    expect(cache.foundDomain('brand.example', { icon: ICON }, RECHECK_MS)).toBe(true);
  });

  test('keeps the icon a domain had when its site turns the Mailroom away', () => {
    const cache = avatarCache(testSql());
    cache.note([ADA], 0);
    cache.foundDomain('brand.example', { icon: ICON }, 0);

    expect(cache.foundDomain('brand.example', { icon: 'turned away' }, RECHECK_MS)).toBe(false);
    expect(cache.pictures([ADA])).toEqual(new Map([[ADA, ICON.key]]));
    expect(cache.owed(2 * RECHECK_MS, { domains: 8, senders: 8 }).domains).toEqual([
      'brand.example',
    ]);
    // A site that has turned it away from the first gives no icon.
    cache.note(['cy@shop.example'], 0);
    expect(cache.foundDomain('shop.example', { icon: 'turned away' }, 0)).toBe(false);
    expect(cache.pictures(['cy@shop.example'])).toEqual(new Map());
  });

  test('tries a lookup that couldn’t finish again in an hour, keeping the pictures it had', () => {
    const cache = avatarCache(testSql());
    cache.note([ADA], 0);
    cache.foundDomain('brand.example', { logo: LOGO_PICTURE }, 0);
    cache.foundSender(ADA, PHOTO, 0);
    cache.failed({ domain: 'brand.example' }, RECHECK_MS);
    cache.failed({ sender: ADA }, RECHECK_MS);

    expect(cache.pictures([ADA])).toEqual(new Map([[ADA, LOGO_PICTURE.key]]));
    expect(cache.owed(RECHECK_MS + HOUR - 1, { domains: 8, senders: 8 })).toEqual({
      domains: [],
      senders: [],
    });
    expect(cache.owed(RECHECK_MS + HOUR, { domains: 8, senders: 8 })).toEqual({
      domains: ['brand.example'],
      senders: [ADA],
    });
  });

  test('forgets every sender but those still sending the member’s mail, with their domains and pictures', () => {
    const sql = testSql();
    const cache = avatarCache(sql);
    cache.note([ADA, 'gone@gone.example', 'left@brand.example'], 0);
    cache.foundDomain('brand.example', { icon: ICON }, 0);
    cache.foundDomain('gone.example', { logo: LOGO_PICTURE }, 0);
    cache.foundSender('left@brand.example', PHOTO, 0);
    cache.keep(new Set([ADA]));

    expect(cache.pictures([ADA, 'gone@gone.example', 'left@brand.example'])).toEqual(
      new Map([
        [ADA, ICON.key],
        ['left@brand.example', ICON.key],
      ]),
    );
    expect(sql.all(`SELECT key FROM avatar_pictures`)).toEqual([{ key: ICON.key }]);
    // A lookup that ends after its sender or domain went keeps nothing.
    expect(cache.foundDomain('gone.example', { logo: LOGO_PICTURE }, 1)).toBe(false);
    expect(cache.foundSender('gone@gone.example', PHOTO, 1)).toBe(false);
    expect(sql.all(`SELECT key FROM avatar_pictures`)).toEqual([{ key: ICON.key }]);
  });

  test('owes a lookup now for the verified senders of mail indexed before it, and their domains', () => {
    // A Mailroom as the release before the Avatar cache left it, holding a logo and some mail.
    const sql = testSql(14);
    sql.run(`INSERT INTO logos (domain, svg, checked_at) VALUES ('brand.example', ?, 0)`, LOGO);
    const message = (uid: number, from: string, verified: boolean) =>
      sql.run(
        `INSERT INTO messages (account, path, uid_validity, uid, conversation, message) VALUES ('personal', 'INBOX', 1, ?, ?, ?)`,
        uid,
        `c${uid}`,
        JSON.stringify({ from: { email: from }, ...(verified ? { verified } : {}) }),
      );
    message(1, ' News@Brand.Example', true);
    message(2, 'news@brand.example', true);
    message(3, 'pat@people.example', true);
    message(4, 'forged@else.example', false);
    message(5, 'nobody', true);
    upgrade(sql);

    expect(avatarCache(sql).owed(0, { domains: 8, senders: 8 })).toEqual({
      domains: ['brand.example', 'people.example'],
      senders: ['news@brand.example', 'pat@people.example'],
    });
    expect(sql.all(`SELECT name FROM sqlite_master WHERE name = 'logos'`)).toEqual([]);
  });

  test('keys a picture by the SHA-256 of its bytes', async () => {
    expect((await keyed(svgOf(''))).key).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
    expect(ICON.key).toMatch(/^[0-9a-f]{64}$/);
    expect(ICON.key).not.toBe(PHOTO.key);
  });
});

/** DNS, pictures and home pages as a test sets them, recording what was asked. */
function network({
  txt = {},
  pictures = {},
  homes = {},
}: {
  txt?: Record<string, string[]>;
  pictures?: Record<string, Picture>;
  homes?: Record<string, Partial<Home>>;
}) {
  const asked: string[] = [];
  const net: AvatarNetwork = {
    txt: (name) => {
      asked.push(name);
      return Promise.resolve(txt[name] ?? []);
    },
    picture: (location) => {
      asked.push(location);
      return Promise.resolve(pictures[location]);
    },
    gravatar: (hash) => {
      asked.push(`gravatar:${hash}`);
      return Promise.resolve(pictures[`gravatar:${hash}`]);
    },
    home: (domain) => {
      asked.push(`home:${domain}`);
      const site = `https://${domain}/`;
      return Promise.resolve({
        site,
        page: site,
        links: [],
        isTurnedAway: false,
        ...homes[domain],
      });
    },
  };
  return { net, asked };
}

const BIMI = 'v=BIMI1; l=https://cdn.brand.example/logo.svg';
const ENFORCING = {
  '_dmarc.brand.example': ['v=DMARC1; p=reject'],
  'default._bimi.brand.example': [BIMI],
};
const LOGO_AT = { 'https://cdn.brand.example/logo.svg': svgOf(LOGO) };

describe('looking a domain’s pictures up', () => {
  test('finds the SVG its BIMI record names while its DMARC policy enforces, and asks its site nothing', async () => {
    const { net, asked } = network({ txt: ENFORCING, pictures: LOGO_AT });
    expect(await lookUpDomain('brand.example', net)).toEqual({ logo: svgOf(LOGO) });
    expect(asked).not.toContain('home:brand.example');
  });

  test('falls back to the organizational domain’s record and policy', async () => {
    const { net } = network({ txt: ENFORCING, pictures: LOGO_AT });
    expect(await lookUpDomain('news.brand.example', net)).toEqual({ logo: svgOf(LOGO) });
  });

  test('without a logo, finds the icon its organizational domain’s home page names', async () => {
    const { net, asked } = network({
      txt: { '_dmarc.brand.example': ['v=DMARC1; p=none'], 'default._bimi.brand.example': [BIMI] },
      pictures: { ...LOGO_AT, 'https://brand.example/icon.png': png('icon') },
      homes: { 'brand.example': { links: [{ rel: 'icon', href: '/icon.png', sizes: '96x96' }] } },
    });
    expect(await lookUpDomain('news.brand.example', net)).toEqual({ icon: png('icon') });
    // A policy of none fetches no logo.
    expect(asked).not.toContain('default._bimi.brand.example');
    expect(asked).not.toContain('https://cdn.brand.example/logo.svg');
    expect(asked).toContain('home:brand.example');
  });

  test('takes an icon from where sites keep one when the page names none that serves', async () => {
    const { net, asked } = network({
      txt: { '_dmarc.brand.example': ['v=DMARC1; p=quarantine; pct=50'] },
      pictures: { 'https://brand.example/favicon.ico': png('ico') },
      homes: { 'brand.example': { links: [{ rel: 'icon', href: '/gone.png' }] } },
    });
    expect(await lookUpDomain('brand.example', net)).toEqual({ icon: png('ico') });
    expect(asked.slice(-3)).toEqual([
      'https://brand.example/gone.png',
      'https://brand.example/apple-touch-icon.png',
      'https://brand.example/favicon.ico',
    ]);
  });

  test('tries at most four places for an icon, and says whether the site named none or turned it away', async () => {
    const links = ['/1.png', '/2.png', '/3.png', '/4.png', '/5.png'].map((href) => ({
      rel: 'icon',
      href,
    }));
    const { net, asked } = network({
      txt: { '_dmarc.brand.example': ['v=DMARC1; p=reject'] },
      pictures: { 'https://brand.example/5.png': png('late') },
      homes: { 'brand.example': { links }, 'shop.example': { isTurnedAway: true } },
    });
    expect(await lookUpDomain('brand.example', net)).toEqual({ icon: 'none' });
    expect(asked.filter((location) => location.startsWith('https://'))).toHaveLength(4);
    expect(await lookUpDomain('shop.example', net)).toEqual({ icon: 'turned away' });
  });

  test('keeps no logo that isn’t an SVG, and looks for an icon instead', async () => {
    for (const served of [png('not an svg'), undefined]) {
      const { net } = network({
        txt: ENFORCING,
        pictures: {
          ...(served ? { 'https://cdn.brand.example/logo.svg': served } : {}),
          'https://brand.example/favicon.ico': png('ico'),
        },
      });
      expect(await lookUpDomain('brand.example', net)).toEqual({ icon: png('ico') });
    }
  });

  test('gives no icon to a domain that hosts mailboxes for the public, and asks its site nothing', async () => {
    const { net, asked } = network({
      txt: { '_dmarc.gmail.com': ['v=DMARC1; p=none'] },
      pictures: { 'https://gmail.com/favicon.ico': png('ico') },
    });
    expect(await lookUpDomain('gmail.com', net)).toEqual({});
    expect(asked).toEqual(['_dmarc.gmail.com']);
  });

  test('fails when DNS can’t say, so the cache tries again', async () => {
    const { net } = network({});
    net.txt = () => Promise.reject(new Error('DNS couldn’t answer.'));
    await expect(lookUpDomain('brand.example', net)).rejects.toThrow('DNS couldn’t answer.');
  });

  test('asks Gravatar for a sender only by their address’s SHA-256', async () => {
    const { net, asked } = network({});
    net.gravatar = (asked_) => {
      asked.push(asked_);
      return Promise.resolve(undefined);
    };
    await internetSources(net).sender(ADA);
    // The SHA-256 of the address's bytes, as `keyed` takes it of a picture's.
    expect(asked).toEqual([(await keyed(svgOf(ADA))).key]);
  });
});

describe('the internet, as a lookup reaches it', () => {
  let internet: ReturnType<typeof spyOn<typeof globalThis, 'fetch'>> | undefined;
  afterEach(() => internet?.mockRestore());

  /** Answers each request by its URL, and records them with what they said. */
  function answering(routes: Record<string, () => Response | Promise<Response>>) {
    const asked: string[] = [];
    const headers: Headers[] = [];
    internet = spyOn(globalThis, 'fetch').mockImplementation(((
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const url = input instanceof Request ? input.url : input.toString();
      asked.push(url);
      headers.push(new Headers(init?.headers));
      return Promise.resolve(routes[url]?.() ?? new Response('', { status: 404 }));
    }) as typeof fetch);
    return Object.assign(asked, { headers });
  }

  const dns = (body: object) => () => Response.json(body);
  const asking = (name: string) => `${INTERNET.dns}?name=${name}&type=TXT`;
  const net = avatarNetwork(INTERNET);

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
    expect(await net.txt('_dmarc.brand.example')).toEqual(['v=DMARC1; p=reject']);
    expect(await net.txt('_dmarc.nowhere.example')).toEqual([]);
  });

  test('fails when DNS can’t answer', async () => {
    answering({ [asking('_dmarc.broken.example')]: dns({ Status: 2 }) });
    await expect(net.txt('_dmarc.broken.example')).rejects.toThrow();
    await expect(net.txt('_dmarc.unknown.example')).rejects.toThrow('404');
  });

  test('fetches a picture over HTTPS from a public host, following redirects that stay so, and says who asks', async () => {
    const asked = answering({
      'https://brand.example/logo.svg': () =>
        new Response(null, { status: 301, headers: { location: '/v2/logo.svg' } }),
      'https://brand.example/v2/logo.svg': () => new Response(LOGO),
    });
    expect(await net.picture('https://brand.example/logo.svg')).toEqual(svgOf(LOGO));
    expect([...asked]).toEqual([
      'https://brand.example/logo.svg',
      'https://brand.example/v2/logo.svg',
    ]);
    expect(asked.headers[0]?.get('user-agent')).toStartWith('TrailMix');
  });

  test('fetches nothing from a plain HTTP or private location, at any hop', async () => {
    const asked = answering({
      'https://brand.example/to-http': () =>
        new Response(null, { status: 302, headers: { location: 'http://brand.example/logo.svg' } }),
      'https://brand.example/to-here': () =>
        new Response(null, { status: 302, headers: { location: 'https://127.0.0.1/logo.svg' } }),
    });
    for (const location of [
      'http://brand.example/logo.svg',
      'https://localhost/logo.svg',
      'https://10.0.0.8/logo.svg',
      'https://user:secret@brand.example/logo.svg',
      'https://brand.example/to-http',
      'https://brand.example/to-here',
    ]) {
      expect(await net.picture(location)).toBeUndefined();
    }
    expect([...asked]).toEqual(['https://brand.example/to-http', 'https://brand.example/to-here']);
  });

  test('a test’s stand-in serves everything from this machine', async () => {
    const asked = answering({
      'https://localhost:4443/logo.svg': () => new Response(LOGO),
      'https://localhost:4443/gravatar/abc?s=96&d=404': () => new Response(PNG),
      'https://localhost:4443/sites/brand.test/': () =>
        new Response('<link rel="icon" href="icon.png">', {
          headers: { 'content-type': 'text/html' },
        }),
    });
    const { avatarNetwork: reach, standInInternet } = await import('./avatars.ts');
    const standIn = reach(standInInternet('https://localhost:4443'), true);
    expect(await standIn.picture('https://localhost:4443/logo.svg')).toEqual(svgOf(LOGO));
    expect(await standIn.gravatar('abc')).toEqual({ type: 'image/png', bytes: PNG });
    expect((await standIn.home('brand.test')).links).toEqual([{ rel: 'icon', href: 'icon.png' }]);
    expect(asked).toHaveLength(3);
  });

  test('keeps a picture by its bytes, whatever its host labels it', async () => {
    answering({
      'https://brand.example/page.png': () =>
        new Response('<!doctype html><script>alert(1)</script>', {
          headers: { 'content-type': 'image/png' },
        }),
      'https://brand.example/icon': () =>
        new Response(PNG, { headers: { 'content-type': 'text/html' } }),
      'https://brand.example/latin1.svg': () => new Response(new Uint8Array([0x3c, 0xe9, 0x3e])),
      'https://brand.example/scripted.svg': () =>
        new Response(LOGO.replace('<rect', '<script>alert(1)</script><rect'), {
          headers: { 'content-type': 'image/svg+xml' },
        }),
    });
    expect(await net.picture('https://brand.example/page.png')).toBeUndefined();
    expect(await net.picture('https://brand.example/icon')).toEqual({
      type: 'image/png',
      bytes: PNG,
    });
    expect(await net.picture('https://brand.example/latin1.svg')).toBeUndefined();
    expect(await net.picture('https://brand.example/scripted.svg')).toBeUndefined();
    expect(await net.picture('https://brand.example/missing.png')).toBeUndefined();
  });

  test('reads no further than 64 KB of a picture, whether or not its host says its size', async () => {
    let pulled = 0;
    const exact = new Uint8Array(PICTURE_BYTES);
    exact.set(PNG);
    answering({
      'https://brand.example/declared.png': () =>
        new Response(PNG, { headers: { 'content-length': String(PICTURE_BYTES + 1) } }),
      'https://brand.example/endless.png': () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(PNG);
            },
            pull(controller) {
              pulled += 1;
              controller.enqueue(new Uint8Array(1024));
            },
          }),
        ),
      'https://brand.example/exact.png': () => new Response(exact),
    });
    expect(await net.picture('https://brand.example/declared.png')).toBeUndefined();
    expect(await net.picture('https://brand.example/endless.png')).toBeUndefined();
    expect(pulled).toBeLessThanOrEqual(PICTURE_BYTES / 1024 + 2);
    expect((await net.picture('https://brand.example/exact.png'))?.bytes).toHaveLength(
      PICTURE_BYTES,
    );
  });

  test('asks Gravatar for a photo by hash, and finds none where it keeps none', async () => {
    const at = (hash: string) => `${INTERNET.gravatar}${hash}?s=96&d=404`;
    const asked = answering({
      [at('kept')]: () => new Response(PNG, { headers: { 'content-type': 'image/png' } }),
      [at('page')]: () =>
        new Response('<!doctype html>', { headers: { 'content-type': 'image/png' } }),
      [at('down')]: () => new Response('', { status: 503 }),
    });
    expect(await net.gravatar('kept')).toEqual({ type: 'image/png', bytes: PNG });
    expect(await net.gravatar('none')).toBeUndefined();
    expect(await net.gravatar('page')).toBeUndefined();
    await expect(net.gravatar('down')).rejects.toThrow('503');
    expect(asked[0]).toBe('https://gravatar.com/avatar/kept?s=96&d=404');
  });

  test('reads the icons a home page names, against its base and where its redirects ended', async () => {
    answering({
      'https://brand.example/': () =>
        new Response(null, { status: 301, headers: { location: 'https://www.brand.example/en/' } }),
      'https://www.brand.example/en/': () =>
        new Response(
          `<!doctype html><html><head><base href="/assets/"><link rel="stylesheet" href="site.css">
           <link rel="icon" type="image/svg+xml" href="icon.svg"><link rel="apple-touch-icon" sizes="180x180" href="/touch.png">
           </head><body><link rel="icon" href="late.png"></body></html>`,
          { headers: { 'content-type': 'text/html; charset=utf-8' } },
        ),
    });
    expect(await net.home('brand.example')).toEqual({
      site: 'https://brand.example/',
      page: 'https://www.brand.example/assets/',
      links: [
        { rel: 'stylesheet', href: 'site.css' },
        { rel: 'icon', href: 'icon.svg', type: 'image/svg+xml' },
        { rel: 'apple-touch-icon', href: '/touch.png', sizes: '180x180' },
        { rel: 'icon', href: 'late.png' },
      ],
      isTurnedAway: false,
    });
  });

  test('reads no further than 256 KB of a home page', async () => {
    const head = `<link rel="icon" href="/early.png">${' '.repeat(256 * 1024)}<link rel="icon" href="/late.png">`;
    answering({
      'https://brand.example/': () =>
        new Response(head, { headers: { 'content-type': 'text/html' } }),
    });
    expect((await net.home('brand.example')).links).toEqual([{ rel: 'icon', href: '/early.png' }]);
  });

  test('a site that refuses, challenges, fails or can’t be reached turned the Mailroom away', async () => {
    const page = '<link rel="icon" href="/icon.png">';
    answering({
      'https://refused.example/': () => new Response(page, { status: 403 }),
      'https://busy.example/': () => new Response(page, { status: 429 }),
      'https://broken.example/': () => new Response(page, { status: 502 }),
      'https://challenged.example/': () =>
        new Response(page, {
          headers: { 'cf-mitigated': 'challenge', 'content-type': 'text/html' },
        }),
      'https://unreachable.example/': () => Promise.reject(new Error('connection refused')),
    });
    for (const domain of [
      'refused.example',
      'busy.example',
      'broken.example',
      'unreachable.example',
    ]) {
      const site = `https://${domain}/`;
      expect(await net.home(domain)).toEqual({ site, page: site, links: [], isTurnedAway: true });
    }
    expect(await net.home('challenged.example')).toMatchObject({ links: [], isTurnedAway: true });
  });

  test('a site with no home page, or none over HTTPS from a public host, names no icon', async () => {
    answering({
      'https://plain.example/': () =>
        new Response(null, { status: 301, headers: { location: 'http://plain.example/' } }),
      'https://inside.example/': () =>
        new Response(null, { status: 302, headers: { location: 'https://192.168.1.1/' } }),
      'https://text.example/': () =>
        new Response('<link rel="icon" href="/icon.png">', {
          headers: { 'content-type': 'text/plain' },
        }),
    });
    for (const domain of ['plain.example', 'inside.example', 'nothing.example', 'text.example']) {
      expect(await net.home(domain)).toMatchObject({ links: [], isTurnedAway: false });
    }
  });
});
