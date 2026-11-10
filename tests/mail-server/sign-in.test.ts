import { afterAll, describe, expect, test } from 'bun:test';
import { signInStandIn, type Requested } from './sign-in.ts';

// The stand-in answers as Microsoft's sign-in does, so code built against it meets the same
// answers as it will in production.

const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  fetch: (request) => standIn.fetch(request),
});
const origin = `http://127.0.0.1:${server.port}`;
const standIn = signInStandIn(origin);
afterAll(() => server.stop(true));

type Body = Record<string, unknown> & { error?: string };

async function post(path: string, form: Record<string, string>) {
  const response = await fetch(`${origin}${path}`, {
    method: 'POST',
    body: new URLSearchParams(form),
  });
  return { status: response.status, body: await response.json<Body>() };
}

/** Plays the person at the sign-in page, with the stand-in's controls. */
const person = (userCode: unknown, form: Record<string, string>) =>
  fetch(`${origin}/devicelogin`, {
    method: 'POST',
    body: new URLSearchParams({ user_code: String(userCode), ...form }),
  });

const requests = async () => (await fetch(`${origin}/requests`)).json<Requested[]>();

describe('the stand-in for Microsoft’s sign-in', () => {
  const MICROSOFT = '/consumers/oauth2/v2.0';
  const device = 'urn:ietf:params:oauth:grant-type:device_code';

  async function signIn(scope: string, controls: Record<string, string> = {}) {
    const started = await post(`${MICROSOFT}/devicecode`, { client_id: 'entra', scope });
    await person(started.body.user_code, { login_hint: 'me@outlook.test', ...controls });
    const poll = () =>
      post(`${MICROSOFT}/token`, {
        grant_type: device,
        client_id: 'entra',
        device_code: String(started.body.device_code),
      });
    return { started, poll };
  }

  const refresh = (token: unknown) =>
    post(`${MICROSOFT}/token`, {
      grant_type: 'refresh_token',
      client_id: 'entra',
      refresh_token: String(token),
    });

  test('gives a refresh token only to a sign-in that asked for offline_access', async () => {
    const online = await (await signIn('imap smtp')).poll();
    expect(online.body.access_token).toBeString();
    expect(online.body.refresh_token).toBeUndefined();
    const offline = await (await signIn('imap smtp offline_access')).poll();
    expect(offline.body.refresh_token).toBeString();
  });

  test('rotates the refresh token on each refresh, and refuses the spent one', async () => {
    const first = await (await signIn('imap offline_access')).poll();
    const second = await refresh(first.body.refresh_token);
    expect(second.status).toBe(200);
    expect(second.body.refresh_token).not.toBe(first.body.refresh_token);
    expect(standIn.userOf(String(second.body.access_token))).toBe('me@outlook.test');
    expect(await refresh(first.body.refresh_token)).toEqual({
      status: 400,
      body: { error: 'invalid_grant', error_description: 'invalid_grant' },
    });
  });

  test('a revoked person’s refresh tokens are refused, and their tokens stop when they expire', async () => {
    const { poll } = await signIn('imap offline_access', { expires_in: '1' });
    const tokens = await poll();
    expect(tokens.body.expires_in).toBe(1);
    expect(standIn.userOf(String(tokens.body.access_token))).toBe('me@outlook.test');
    await Bun.sleep(1100);
    expect(standIn.userOf(String(tokens.body.access_token))).toBeUndefined();
    const introspected = await fetch(
      `${origin}/introspect?access_token=${String(tokens.body.access_token)}`,
    );
    expect(await introspected.json()).toEqual({ active: 'false' });

    await fetch(`${origin}/revoke`, {
      method: 'POST',
      body: new URLSearchParams({ login_hint: 'ME@outlook.test' }),
    });
    expect((await refresh(tokens.body.refresh_token)).body.error).toBe('invalid_grant');
  });

  test('tells the next poll to slow down once, then waits for the person', async () => {
    const started = await post(`${MICROSOFT}/devicecode`, { client_id: 'entra', scope: 'imap' });
    await person(started.body.user_code, { slow_down: '1' });
    const poll = () =>
      post(`${MICROSOFT}/token`, {
        grant_type: device,
        client_id: 'entra',
        device_code: String(started.body.device_code),
      });
    expect((await poll()).body.error).toBe('slow_down');
    expect((await poll()).body.error).toBe('authorization_pending');
  });

  test('records what each token request asked for, and what it got', async () => {
    const before = (await requests()).length;
    const tokens = await (await signIn('imap offline_access')).poll();
    await refresh(tokens.body.refresh_token);
    expect((await requests()).slice(before)).toEqual([
      {
        endpoint: 'device code',
        grantType: null,
        scope: 'imap offline_access',
        clientId: 'entra',
        answer: 'ok',
      },
      {
        endpoint: 'token',
        grantType: device,
        scope: null,
        clientId: 'entra',
        user: 'me@outlook.test',
        answer: 'ok',
      },
      {
        endpoint: 'token',
        grantType: 'refresh_token',
        scope: null,
        clientId: 'entra',
        user: 'me@outlook.test',
        answer: 'ok',
      },
    ]);
  });
});
