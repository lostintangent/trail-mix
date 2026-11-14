import { expect, mock, spyOn, test } from 'bun:test';
import { generateKeyPair, SignJWT } from 'jose';
import type { Timed } from '../features/mailroom/client/contract.ts';

/**
 * The Worker's gate, with Start standing in as a handler that records what reached the app. The
 * development member stands in for a verified sign-in, which `access.test.ts` covers.
 */

const reachedApp: { url: string; mailroom: unknown }[] = [];
type Context = { mailroom: () => unknown; timing: Timed[] };
await mock.module('@tanstack/react-start/server-entry', () => ({
  default: {
    fetch(request: Request, { context }: { context: Context }) {
      reachedApp.push({ url: request.url, mailroom: tried(context.mailroom) });
      // A call notes its parts of the request's time, as `rpc.ts` does.
      if (request.url.includes('/_serverFn/')) {
        context.timing.push({ name: 'mailroom', ms: 12.34, note: 'conversation' });
      }
      return new Response('the app', { headers: { 'Content-Type': 'text/plain' } });
    },
  },
}));

/** What `reach` returns, or what it threw. */
function tried(reach: () => unknown): unknown {
  try {
    return reach();
  } catch (error) {
    return error;
  }
}

// The Mailroom and the demo's visitor gate run only on workerd, and the Worker here only names them.
await mock.module('../features/mailroom/server/index.ts', () => ({ Mailroom: class {} }));
await mock.module('cloudflare:workers', () => ({ DurableObject: class {} }));
const { default: entry } = await import('./entry.ts');
/** The Worker as Cloudflare calls it. Nothing here keeps work running past its response. */
const worker = {
  fetch: (request: Request, env: { [Name in keyof Cloudflare.Env]?: unknown }) =>
    entry.fetch(request, env as Cloudflare.Env, { waitUntil() {} } as unknown as ExecutionContext),
};

/** The key of a picture a Mailroom's Avatar cache holds. */
const PICTURE = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

/** Mailrooms by name, recording each one the Worker opened and each socket it was handed. */
function mailrooms() {
  const opened: string[] = [];
  const sockets: Request[] = [];
  const sources: string[] = [];
  const avatars: [member: string, key: string][] = [];
  /** What the Worker did to a Mailroom beyond opening it. */
  const did: [member: string, what: string][] = [];
  const MAILROOM = {
    getByName(name: string) {
      opened.push(name);
      return {
        name,
        fetch: (request: Request) => {
          sockets.push(request);
          return Promise.resolve(new Response(null, { status: 200 }));
        },
        source: () => {
          sources.push(name);
          return Promise.resolve(new Response(`the source of ${name}'s message`).body);
        },
        avatar: (key: string) => {
          avatars.push([name, key]);
          return Promise.resolve(
            key === PICTURE
              ? { type: 'image/png', bytes: new TextEncoder().encode(`${name}'s picture`) }
              : null,
          );
        },
        answer: (call: { name: string; args: unknown[] }) => {
          did.push([name, JSON.stringify(call)]);
          return JSON.stringify(call.args[0]) === '["gone"]'
            ? Promise.reject(new Error('That message is no longer in this mailbox.'))
            : Promise.resolve({ value: undefined, reached: 0, ran: 0, spent: [], cold: false });
        },
      };
    },
  };
  return { MAILROOM, opened, sockets, sources, avatars, did };
}

const LOCAL = 'http://localhost:5173';
const SITE = 'https://mail.example.com';
const developer = (rooms = mailrooms()) => ({
  ...rooms,
  env: { ...rooms, DEV_MEMBER: 'ada@example.com' },
});

/** Everything a browser could say about who it is, naming someone else. */
const SOMEONE_ELSE = {
  'Cf-Access-Authenticated-User-Email': 'eve@example.com',
  'Cf-Access-Jwt-Assertion': 'eve@example.com',
  Cookie: 'CF_Authorization=eve@example.com; member=eve@example.com',
  'X-Member': 'eve@example.com',
};

test('the health endpoint answers without sign-in, with the version alone', async () => {
  const { env, opened } = developer();
  const response = await worker.fetch(new Request('https://mail.example.com/health'), {
    ...env,
    VERSION: 'abc1234',
  });

  expect(await response.json()).toEqual({ version: 'abc1234' });
  expect(opened).toEqual([]);
});

test('the app’s responses say where their time went, in names and times alone', async () => {
  // A module of its own is an isolate of its own, whose first request started it.
  const { default: fresh } = (await import(`./entry.ts?isolate=${Date.now()}`)) as {
    default: typeof worker;
  };
  const { env } = developer();
  const timingOf = async (path: string) => {
    const response = await fresh.fetch(new Request(`${LOCAL}${path}`), env);
    expect(await response.text()).toBe('the app');
    expect(response.headers.get('Content-Type')).toBe('text/plain');
    return response.headers.get('Server-Timing');
  };

  expect(await timingOf('/_serverFn/query')).toMatch(
    /^isolate;desc="The Worker started for this request", access;dur=[\d.]+, mailroom;dur=12\.3;desc="conversation", worker;dur=[\d.]+$/,
  );
  expect(await timingOf('/_serverFn/query')).toMatch(
    /^access;dur=[\d.]+, mailroom;dur=12\.3;desc="conversation", worker;dur=[\d.]+$/,
  );
  expect(await timingOf('/')).toMatch(/^access;dur=[\d.]+, worker;dur=[\d.]+$/);
  const health = await fresh.fetch(new Request(`${LOCAL}/health`), env);
  expect(health.headers.get('Server-Timing')).toBeNull();
});

test('a deployment with no sign-in configured serves the setup page and nothing else', async () => {
  const rooms = mailrooms();
  reachedApp.length = 0;

  for (const path of ['/', '/_serverFn/abc', '/updates', '/messages/personal/INBOX/1/2']) {
    const response = await worker.fetch(new Request(`https://mail.example.com${path}`), rooms);
    expect(response.status).toBe(503);
    expect(await response.text()).toContain('isn’t set up yet');
  }
  expect(rooms.opened).toEqual([]);
  expect(reachedApp).toEqual([]);
});

test('the setup page names the address to put behind Access, and the README’s steps', async () => {
  const page = await (
    await worker.fetch(new Request('https://trail-mix.ada.workers.dev/'), mailrooms())
  ).text();
  expect(page).toContain('<code>trail-mix.ada.workers.dev</code>');
  expect(page).toContain('ACCESS_TEAM_DOMAIN');
  expect(page).toContain('github.com/lostintangent/trail-mix#2-sign-in-with-cloudflare-access');

  const local = await (await worker.fetch(new Request(`${LOCAL}/`), mailrooms())).text();
  expect(local).toContain('copy <code>dev.vars.example</code> to <code>.dev.vars</code>');
});

test('a request nobody signed in to reaches no Mailroom and not the app', async () => {
  const { env, opened } = developer();
  reachedApp.length = 0;
  const response = await worker.fetch(
    new Request('https://mail.example.com/', { headers: SOMEONE_ELSE }),
    env,
  );

  expect(response.status).toBe(401);
  expect(opened).toEqual([]);
  expect(reachedApp).toEqual([]);
});

test('the signed-in member’s Mailroom is the only one the app is handed, whoever the request names', async () => {
  const { env, opened } = developer();
  reachedApp.length = 0;
  const requests = [
    new Request(`${LOCAL}/?member=eve@example.com`, { headers: SOMEONE_ELSE }),
    new Request(`${LOCAL}/_serverFn/query?payload=eve@example.com`, { headers: SOMEONE_ELSE }),
    new Request(`${LOCAL}/_serverFn/command`, {
      method: 'POST',
      headers: { ...SOMEONE_ELSE, Origin: LOCAL, 'Sec-Fetch-Site': 'same-origin' },
      body: JSON.stringify({ member: 'eve@example.com' }),
    }),
  ];
  for (const request of requests) await worker.fetch(request, env);

  expect(opened).toEqual(['ada@example.com', 'ada@example.com', 'ada@example.com']);
  expect(reachedApp.map(({ mailroom }) => (mailroom as { name: string }).name)).toEqual([
    'ada@example.com',
    'ada@example.com',
    'ada@example.com',
  ]);
});

test('a page from before Members went is told its member isn’t the operator, and reaches no Mailroom', async () => {
  const { env, opened } = developer();
  reachedApp.length = 0;
  // Its call, as Start's client sends it.
  const call =
    '{"t":{"t":10,"i":0,"p":{"k":["data"],"v":[{"t":10,"i":1,"p":{"k":["name","args"],"v":[{"t":1,"s":"isOperator"},{"t":9,"i":2,"a":[],"o":0}]},"o":0}]},"o":0},"f":127,"m":[]}';
  const response = await worker.fetch(
    new Request(
      `${LOCAL}/_serverFn/a6969e39de41deb4e8b9de8cb827341a0bd2092320434bc9d73e01414913a09c?payload=${encodeURIComponent(call)}`,
    ),
    env,
  );

  expect(await response.json()).toEqual({ result: false });
  expect(opened).toEqual([]);
  expect(reachedApp).toEqual([]);
});

test('a command, a socket or a notification’s button that another site started is refused before sign-in is consulted', async () => {
  // With Access configured, consulting sign-in about a well-formed token fetches the team's
  // certificates, so a fetch that never happens shows sign-in was never asked.
  const certificates = spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(null, { status: 503 }),
  );
  const rooms = mailrooms();
  const env = { ...rooms, ACCESS_TEAM_DOMAIN: 'trailmix.cloudflareaccess.com', ACCESS_AUD: 'app' };
  const { privateKey } = await generateKeyPair('RS256');
  const signed = await new SignJWT({ email: 'ada@example.com' })
    .setProtectedHeader({ alg: 'RS256', kid: 'access' })
    .sign(privateKey);
  const elsewhere: Record<string, string>[] = [
    { Origin: 'https://evil.example', 'Sec-Fetch-Site': 'cross-site' },
    { Origin: 'https://evil.example' },
    { 'Sec-Fetch-Site': 'same-site' },
    {},
  ];

  for (const site of elsewhere) {
    const headers = { ...site, 'Cf-Access-Jwt-Assertion': signed };
    const command = new Request(`${SITE}/_serverFn/command`, { method: 'POST', headers });
    const socket = new Request(`${SITE}/updates`, {
      headers: { ...headers, Upgrade: 'websocket' },
    });
    const button = new Request(`${SITE}/notifications/act`, { method: 'POST', headers });
    expect((await worker.fetch(command, env)).status).toBe(403);
    expect((await worker.fetch(socket, env)).status).toBe(403);
    expect((await worker.fetch(button, env)).status).toBe(403);
  }
  expect(certificates).not.toHaveBeenCalled();
  expect(rooms.opened).toEqual([]);

  const fromTrailMix = new Request(`${SITE}/_serverFn/command`, {
    method: 'POST',
    headers: { Origin: SITE, 'Cf-Access-Jwt-Assertion': signed },
  });
  await worker.fetch(fromTrailMix, env);
  expect(certificates).toHaveBeenCalled();
  certificates.mockRestore();
});

test('the hint socket reaches the member’s Mailroom carrying nothing the browser sent', async () => {
  const { env, opened, sockets } = developer();
  const request = new Request(`${LOCAL}/updates?member=eve@example.com`, {
    headers: { ...SOMEONE_ELSE, Origin: LOCAL, Upgrade: 'websocket' },
  });
  await worker.fetch(request, env);

  expect(opened).toEqual(['ada@example.com']);
  expect(sockets.map(({ url }) => url)).toEqual([`${LOCAL}/updates`]);
  expect([...sockets[0]!.headers.keys()]).toEqual(['upgrade']);
});

test('a message’s bytes come only from the signed-in member’s Mailroom, whoever the request names', async () => {
  const { env, opened, sources } = developer();
  const response = await worker.fetch(
    new Request(`${LOCAL}/messages/personal/INBOX/1/7?member=eve@example.com`, {
      headers: SOMEONE_ELSE,
    }),
    env,
  );

  expect(await response.text()).toBe("the source of ada@example.com's message");
  expect(opened).toEqual(['ada@example.com']);
  expect(sources).toEqual(['ada@example.com']);
});

test('a notification’s button reaches only the signed-in member’s Mailroom, as the command it stands for', async () => {
  const { env, did } = developer();
  const ref = { account: 'personal', path: 'INBOX', uidValidity: 7, uid: 1 };
  const press = (body: unknown, init: RequestInit = {}) =>
    worker.fetch(
      new Request(`${LOCAL}/notifications/act?member=eve@example.com`, {
        method: 'POST',
        headers: { ...SOMEONE_ELSE, 'Sec-Fetch-Site': 'same-origin' },
        body: JSON.stringify(body),
        ...init,
      }),
      env,
    );

  expect((await press({ action: 'archive', message: ref })).status).toBe(204);
  expect((await press({ action: 'read', message: ref })).status).toBe(204);
  expect(did).toEqual([
    ['ada@example.com', JSON.stringify({ name: 'move', args: [[ref], 'archive'] })],
    ['ada@example.com', JSON.stringify({ name: 'setFlags', args: [[ref], { seen: true }] })],
  ]);

  // Anything else a button can't ask, and a refusal says why.
  for (const asked of [{ action: 'delete', message: ref }, { action: 'archive' }, 'archive']) {
    expect((await press(asked)).status).toBe(400);
  }
  expect(
    (await press({ action: 'read', message: ref }, { method: 'GET', body: null })).status,
  ).toBe(405);
  const gone = await press({ action: 'read', message: 'gone' });
  expect([gone.status, await gone.text()]).toEqual([
    409,
    'That message is no longer in this mailbox.',
  ]);
});

test('an avatar comes only from the signed-in member’s Avatar cache, as an image that runs nothing', async () => {
  const { env, opened, avatars } = developer();
  const response = await worker.fetch(
    new Request(`${LOCAL}/avatars/${PICTURE}?member=eve@example.com`, { headers: SOMEONE_ELSE }),
    env,
  );

  expect(await response.text()).toBe("ada@example.com's picture");
  expect(response.headers.get('content-type')).toBe('image/png');
  expect(response.headers.get('content-security-policy')).toStartWith('sandbox');
  expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  expect(opened).toEqual(['ada@example.com']);
  expect(avatars).toEqual([['ada@example.com', PICTURE]]);

  const missing = await worker.fetch(new Request(`${LOCAL}/avatars/${'0'.repeat(64)}`), env);
  expect(missing.status).toBe(404);
  expect(missing.headers.get('content-security-policy')).toStartWith('sandbox');
});

/** The internet, answering the proxy's one request with an image. */
const anImage = () =>
  spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(new Uint8Array(8), { headers: { 'content-type': 'image/png' } }),
  );
const PROXIED = `/images?url=${encodeURIComponent('https://images.example.com/photo.png')}`;

test('a message’s bytes, the image proxy and avatars refuse a request nobody signed in to', async () => {
  const internet = anImage();
  const { env, opened, sources, avatars } = developer();
  for (const path of [
    '/messages/personal/INBOX/1/7',
    '/messages/personal/INBOX/1/7/1',
    PROXIED,
    `/avatars/${PICTURE}`,
  ]) {
    const response = await worker.fetch(
      new Request(`${SITE}${path}`, { headers: SOMEONE_ELSE }),
      env,
    );
    expect(response.status).toBe(401);
  }

  expect(opened).toEqual([]);
  expect(sources).toEqual([]);
  expect(avatars).toEqual([]);
  expect(internet).not.toHaveBeenCalled();
  internet.mockRestore();
});

test('the image proxy serves a signed-in member’s request from Trail Mix’s own pages', async () => {
  const internet = anImage();
  const { env } = developer();
  const fromTrailMix = new Request(`${LOCAL}${PROXIED}`, {
    headers: { 'Sec-Fetch-Site': 'same-origin' },
  });
  expect((await worker.fetch(fromTrailMix, env)).status).toBe(200);
  expect(internet).toHaveBeenCalledTimes(1);
  internet.mockRestore();
});

test('a deployment of the demo mailbox alone shows its newsletter’s own pictures, and fetches no remote image', async () => {
  const internet = anImage();
  const { env } = developer();
  const image = (url: string) =>
    worker.fetch(
      new Request(`${LOCAL}/images?url=${encodeURIComponent(url)}`, {
        headers: { 'Sec-Fetch-Site': 'same-origin' },
      }),
      { ...env, DEMO_MAILBOX: '200' },
    );

  for (const shown of ['masthead.svg', 'img/flame-2.svg']) {
    const response = await image(`https://kernelweekly.example.com/${shown}`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/svg+xml');
    expect(response.headers.get('content-security-policy')).toStartWith('sandbox');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await response.text()).toStartWith('<svg xmlns="http://www.w3.org/2000/svg"');
  }
  // Its open pixel, and every address its mail doesn't name, has nothing.
  for (const missing of [
    'https://kernelweekly.example.com/open/0.gif',
    'https://kernelweekly.example.com/img/constructor-0.svg',
    'https://images.example.com/photo.png',
  ]) {
    expect((await image(missing)).status).toBe(404);
  }
  expect(internet).not.toHaveBeenCalled();
  internet.mockRestore();
});

/**
 * The public demo, with a visitor gate that lets visitors in while `open` says so, and a limit that
 * takes `changes` a minute from each network.
 */
function demo(open = true, changes = Infinity) {
  const rooms = mailrooms();
  const asked: string[] = [];
  const counted = new Map<string, number>();
  const VISITOR_CHANGES = {
    limit: ({ key }: { key: string }) => {
      counted.set(key, (counted.get(key) ?? 0) + 1);
      return Promise.resolve({ success: counted.get(key)! <= changes });
    },
  };
  const VISITORS = {
    getByName: () => ({
      admit: (visitor: string) => {
        asked.push(visitor);
        return Promise.resolve(open ? Date.now() : undefined);
      },
    }),
  };
  const env = {
    ...rooms,
    VISITORS,
    VISITOR_CHANGES,
    VISITOR_KEY: 'k'.repeat(32),
    DEMO_MAILBOX: '200',
  };
  return { ...rooms, env, asked, counted };
}
const cookieOf = (response: Response) => response.headers.get('Set-Cookie')?.split(';')[0] ?? '';

test('a visitor to the demo is let in at their first call to a Mailroom, which is theirs alone', async () => {
  const { env, asked, opened } = demo();
  const DEMO = 'https://demo.example.com';
  reachedApp.length = 0;
  const page = await worker.fetch(new Request(`${DEMO}/`), env);
  expect(await page.text()).toBe('the app');
  // Serving the page hands the app no Mailroom, so nothing it does there can make one.
  expect(reachedApp[0]!.mailroom).toEqual(new Error('The demo’s gate hasn’t let this visitor in.'));
  expect(opened).toEqual([]);

  reachedApp.length = 0;
  const query = new Request(`${DEMO}/_serverFn/query`, { headers: { Cookie: cookieOf(page) } });
  await worker.fetch(query, env);
  expect((reachedApp[0]!.mailroom as { name: string }).name).toBe(`${asked[0]}@demo.invalid`);
});

test('a visitor the demo has no room for is told so, and reaches no Mailroom and not the app', async () => {
  const { env, opened } = demo(false);
  reachedApp.length = 0;
  for (const path of ['/_serverFn/query', '/updates', '/messages/personal/INBOX/1/7']) {
    const response = await worker.fetch(new Request(`https://demo.example.com${path}`), env);
    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('60');
    expect(await response.text()).toContain('demo is full for now');
  }
  expect(opened).toEqual([]);
  expect(reachedApp).toEqual([]);
});

test('the demo takes only so many changes a minute from one network, and counts no query', async () => {
  const { env, counted } = demo(true, 2);
  const page = await worker.fetch(new Request('https://demo.example.com/'), env);
  const from = (ip: string, method = 'POST') =>
    new Request('https://demo.example.com/_serverFn/command', {
      method,
      headers: {
        Cookie: cookieOf(page),
        'CF-Connecting-IP': ip,
        Origin: 'https://demo.example.com',
        'Sec-Fetch-Site': 'same-origin',
      },
    });
  reachedApp.length = 0;
  const statuses = [];
  for (const ip of ['203.0.113.7', '203.0.113.7', '203.0.113.7', '198.51.100.1']) {
    statuses.push((await worker.fetch(from(ip), env)).status);
  }
  const refused = await worker.fetch(from('203.0.113.7'), env);
  expect(statuses).toEqual([200, 200, 429, 200]);
  expect(refused.headers.get('Retry-After')).toBe('60');
  expect(await refused.text()).toContain('only so many changes a minute');
  // Its cookie still comes back, so the visitor stays who they are.
  expect(cookieOf(refused)).toMatch(/\.\d{10}\./);
  expect(reachedApp).toHaveLength(3);
  // Queries and the page only read, and aren't counted.
  expect((await worker.fetch(from('203.0.113.7', 'GET'), env)).status).toBe(200);
  expect((await worker.fetch(new Request('https://demo.example.com/'), env)).status).toBe(200);
  expect(Object.fromEntries(counted)).toEqual({ '203.0.113.7': 4, '198.51.100.1': 1 });
});
