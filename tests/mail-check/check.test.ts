import { afterAll, describe, expect, test } from 'bun:test';
import { signInStandIn } from '../mail-server/server.ts';
import { outlookScopes, signInWithDeviceCode } from './check.ts';

// Microsoft's endpoints, played by the test mail server's stand-in, with every request recorded.
const standIn = signInStandIn();
const requests: { path: string; form: URLSearchParams }[] = [];
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(request) {
    requests.push({
      path: new URL(request.url).pathname,
      form: new URLSearchParams(await request.clone().text()),
    });
    return standIn.fetch(request);
  },
});
afterAll(() => server.stop(true));

const authority = `http://127.0.0.1:${server.port}/consumers`;
const quickly = () => Bun.sleep(5);

/** Plays the person who opens the page in the message and enters its code. */
function person(action: { login_hint: string } | { decline: string }) {
  return (message: string) => {
    const userCode = /enter the code (\w+)/.exec(message)?.[1] ?? '';
    void fetch(`${server.url}devicelogin`, {
      method: 'POST',
      body: new URLSearchParams({ user_code: userCode, ...action }),
    });
  };
}

describe('signing in with a device code', () => {
  test('shows the code, waits for the person, and returns a token for them', async () => {
    requests.length = 0;
    const token = await signInWithDeviceCode({
      authority,
      clientId: 'entra-app-id',
      scopes: outlookScopes,
      show: person({ login_hint: 'me@outlook.test' }),
      sleep: quickly,
    });
    expect(standIn.userOf(token)).toBe('me@outlook.test');
  });

  test('asks only for IMAP and SMTP, with the client ID it was given and no refresh token', async () => {
    requests.length = 0;
    await signInWithDeviceCode({
      authority,
      clientId: 'entra-app-id',
      scopes: outlookScopes,
      show: person({ login_hint: 'me@outlook.test' }),
      sleep: quickly,
    });
    const start = requests.find((r) => r.path === '/consumers/oauth2/v2.0/devicecode');
    expect(start?.form.get('client_id')).toBe('entra-app-id');
    expect(start?.form.get('scope')?.split(' ')).toEqual([
      'https://outlook.office.com/IMAP.AccessAsUser.All',
      'https://outlook.office.com/SMTP.Send',
    ]);
    const polls = requests.filter((r) => r.path === '/consumers/oauth2/v2.0/token');
    expect(polls.length).toBeGreaterThan(0);
    for (const poll of polls) {
      expect(poll.form.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:device_code');
      expect(poll.form.get('client_id')).toBe('entra-app-id');
    }
  });

  test('fails when the person declines', async () => {
    const signIn = signInWithDeviceCode({
      authority,
      clientId: 'entra-app-id',
      scopes: outlookScopes,
      show: person({ decline: 'yes' }),
      sleep: quickly,
    });
    await expect(signIn).rejects.toThrow('Sign-in was declined.');
  });

  test('waits five seconds longer each time Microsoft says to slow down', async () => {
    const answers = [
      { error: 'slow_down' },
      { error: 'authorization_pending' },
      { error: 'slow_down' },
      { access_token: 'token' },
    ];
    const slow = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(request) {
        if (request.url.endsWith('/devicecode')) {
          return Response.json({
            device_code: 'd',
            user_code: 'U',
            interval: 1,
            expires_in: 900,
            message: 'enter the code U',
          });
        }
        const answer = answers.shift() ?? {};
        return Response.json(answer, { status: 'access_token' in answer ? 200 : 400 });
      },
    });
    const waits: number[] = [];
    try {
      const token = await signInWithDeviceCode({
        authority: `http://127.0.0.1:${slow.port}/consumers`,
        clientId: 'entra-app-id',
        scopes: outlookScopes,
        show: () => {},
        sleep: (ms) => {
          waits.push(ms);
          return Promise.resolve();
        },
      });
      expect(token).toBe('token');
      expect(waits).toEqual([1000, 6000, 6000, 11000]);
    } finally {
      await slow.stop(true);
    }
  });

  test('fails when Microsoft refuses the client ID', async () => {
    const signIn = signInWithDeviceCode({
      authority,
      clientId: '',
      scopes: outlookScopes,
      show: () => {},
      sleep: quickly,
    });
    await expect(signIn).rejects.toThrow('Microsoft refused to start sign-in: invalid_request');
  });
});
