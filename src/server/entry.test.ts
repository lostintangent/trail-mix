import { expect, mock, spyOn, test } from 'bun:test';
import { generateKeyPair, SignJWT } from 'jose';
import type { Mailroom } from '../features/mailroom/client/contract.ts';
import type { MessageBytes } from './routes/messages.ts';

/**
 * The Worker's gate, with Start standing in as a handler that records what reached the app. The
 * development member stands in for a verified sign-in, which `access.test.ts` covers.
 */

const reachedApp: { url: string; mailroom: unknown }[] = [];
await mock.module('@tanstack/react-start/server-entry', () => ({
  default: {
    fetch(request: Request, { context }: { context: { mailroom: unknown } }) {
      reachedApp.push({ url: request.url, mailroom: context.mailroom });
      return new Response('the app');
    },
  },
}));
// The Mailroom runs only on workerd, and the Worker here only names it.
await mock.module('../features/mailroom/server/index.ts', () => ({ Mailroom: class {} }));
const { default: worker } = await import('./entry.ts');

/** Mailrooms by name, recording each one the Worker opened and each socket it was handed. */
function mailrooms() {
  const opened: string[] = [];
  const sockets: Request[] = [];
  const sources: string[] = [];
  const MAILROOM = {
    idFromName: (name: string) => ({ name }),
    get({ name }: { name: string }) {
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
      } as unknown as Mailroom & MessageBytes;
    },
  };
  return { MAILROOM, opened, sockets, sources };
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

test('a command or a socket that another site started is refused before sign-in is consulted', async () => {
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
    expect((await worker.fetch(command, env)).status).toBe(403);
    expect((await worker.fetch(socket, env)).status).toBe(403);
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

/** The internet, answering the proxy's one request with an image. */
const anImage = () =>
  spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(new Uint8Array(8), { headers: { 'content-type': 'image/png' } }),
  );
const PROXIED = `/images?url=${encodeURIComponent('https://images.example.com/photo.png')}`;

test('a message’s bytes and the image proxy refuse a request nobody signed in to', async () => {
  const internet = anImage();
  const { env, opened, sources } = developer();
  for (const path of ['/messages/personal/INBOX/1/7', '/messages/personal/INBOX/1/7/1', PROXIED]) {
    const response = await worker.fetch(
      new Request(`${SITE}${path}`, { headers: SOMEONE_ELSE }),
      env,
    );
    expect(response.status).toBe(401);
  }

  expect(opened).toEqual([]);
  expect(sources).toEqual([]);
  expect(internet).not.toHaveBeenCalled();
  internet.mockRestore();
});

test('the image proxy refuses a signed-in member’s request that another site started', async () => {
  const internet = anImage();
  const { env } = developer();
  for (const site of ['cross-site', 'same-site']) {
    const request = new Request(`${LOCAL}${PROXIED}`, { headers: { 'Sec-Fetch-Site': site } });
    expect((await worker.fetch(request, env)).status).toBe(403);
  }
  expect(internet).not.toHaveBeenCalled();

  const fromTrailMix = new Request(`${LOCAL}${PROXIED}`, {
    headers: { 'Sec-Fetch-Site': 'same-origin' },
  });
  expect((await worker.fetch(fromTrailMix, env)).status).toBe(200);
  expect(internet).toHaveBeenCalledTimes(1);
  internet.mockRestore();
});
