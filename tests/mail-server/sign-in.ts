/**
 * A stand-in for Microsoft's device-code sign-in, answering as login.microsoftonline.com does, at
 * `/<tenant>/oauth2/v2.0/devicecode` and `/<tenant>/oauth2/v2.0/token`. A refresh token comes only
 * to a sign-in that asked for `offline_access`, and each refresh rotates it: the one just used is
 * spent, and a new one comes back.
 *
 * Tests steer it through three endpoints of its own:
 * - `POST /devicelogin` plays the person at the sign-in page. With `user_code` and any of:
 *   `login_hint` signs in as that address, `decline` refuses, `slow_down=1` has the next poll told
 *   to slow down, and `expires_in=N` makes the sign-in's access tokens, refreshed ones too, last N
 *   seconds.
 * - `POST /revoke` with `login_hint` revokes every refresh token of that address.
 * - `GET /requests` lists every request to the device-code and token endpoints: the grant type,
 *   the scope as sent, the client, whose sign-in it was, and the answer. It holds no code or token.
 *
 * Dovecot asks `/introspect` about each XOAUTH2 login, and submission asks `userOf`. Both answer
 * only for an access token that hasn't expired. Everything lives in this process's memory.
 */

/** A sign-in under way, from its device code until it is used. */
type Grant = {
  clientId: string;
  scope: string;
  userCode: string;
  expiresAt: number;
  user?: string;
  declined?: boolean;
  slowDown?: boolean;
  /** Seconds each access token lasts. */
  lifetime: number;
};

type SignedIn = Pick<Grant, 'clientId' | 'scope' | 'lifetime'> & { user: string };

/** What a sign-in endpoint answers, and whose sign-in it was when that's known. */
type Answer = { body: Record<string, unknown>; status?: number; user?: string };

export type Requested = {
  endpoint: 'device code' | 'token';
  grantType: string | null;
  scope: string | null;
  clientId: string | null;
  user?: string;
  answer: string;
};

const ACCESS_SECONDS = 3600;
const CODE_SECONDS = 900;
const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';

export function signInStandIn(origin: string) {
  const grants = new Map<string, Grant>();
  const refreshTokens = new Map<string, SignedIn>();
  const accessTokens = new Map<string, { user: string; expiresAt: number }>();
  const requests: Requested[] = [];
  const random = () => crypto.randomUUID().replaceAll('-', '');
  const verification = `${origin}/devicelogin`;

  function userOf(token: string): string | undefined {
    const held = accessTokens.get(token);
    return held && Date.now() < held.expiresAt ? held.user : undefined;
  }

  async function fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const post = request.method === 'POST';
    const form = post ? new URLSearchParams(await request.text()) : url.searchParams;

    const endpoint = /^\/[^/]+\/oauth2\/v2\.0\/(devicecode|token)$/.exec(url.pathname)?.[1];
    if (post && endpoint) {
      const isCode = endpoint === 'devicecode';
      const { body, status = 200, user } = isCode ? deviceCode(form) : token(form);
      requests.push({
        endpoint: isCode ? 'device code' : 'token',
        grantType: form.get('grant_type'),
        scope: form.get('scope'),
        clientId: form.get('client_id'),
        ...(user ? { user } : {}),
        answer: typeof body.error === 'string' ? body.error : 'ok',
      });
      return Response.json(body, { status });
    }

    if (post && url.pathname === '/devicelogin') {
      const grant = [...grants.values()].find((g) => g.userCode === form.get('user_code'));
      if (!grant) return Response.json({ error: 'invalid_user_code' }, { status: 404 });
      if (form.get('decline')) grant.declined = true;
      if (form.get('login_hint')) grant.user = form.get('login_hint') ?? '';
      if (form.get('slow_down')) grant.slowDown = true;
      if (form.get('expires_in')) grant.lifetime = Number(form.get('expires_in'));
      return new Response(null, { status: 204 });
    }

    if (post && url.pathname === '/revoke') {
      const user = form.get('login_hint')?.toLowerCase();
      for (const [held, signedIn] of refreshTokens) {
        if (signedIn.user.toLowerCase() === user) refreshTokens.delete(held);
      }
      return new Response(null, { status: 204 });
    }

    if (url.pathname === '/requests') return Response.json(requests);

    if (url.pathname === '/introspect') {
      const user = userOf(form.get('access_token') ?? '');
      return Response.json(user ? { active: 'true', email: user } : { active: 'false' });
    }

    return new Response(null, { status: 404 });
  }

  function deviceCode(form: URLSearchParams): Answer {
    const clientId = form.get('client_id');
    if (!clientId) return refused('invalid_request');
    const userCode = random().slice(0, 8).toUpperCase();
    const code = random();
    grants.set(code, {
      clientId,
      scope: form.get('scope') ?? '',
      userCode,
      expiresAt: Date.now() + CODE_SECONDS * 1000,
      lifetime: ACCESS_SECONDS,
    });
    return {
      body: {
        device_code: code,
        user_code: userCode,
        verification_uri: verification,
        expires_in: CODE_SECONDS,
        interval: 1,
        message: `To sign in, use a web browser to open the page ${verification} and enter the code ${userCode} to authenticate.`,
      },
    };
  }

  function token(form: URLSearchParams): Answer {
    const clientId = form.get('client_id');

    if (form.get('grant_type') === 'refresh_token') {
      const held = form.get('refresh_token') ?? '';
      const signedIn = refreshTokens.get(held);
      if (!signedIn || signedIn.clientId !== clientId) return refused('invalid_grant');
      refreshTokens.delete(held);
      return tokensFor(signedIn);
    }

    if (form.get('grant_type') !== DEVICE_GRANT) return refused('unsupported_grant_type');
    const code = form.get('device_code') ?? '';
    const grant = grants.get(code);
    if (!grant || grant.clientId !== clientId) return refused('bad_verification_code');
    if (Date.now() > grant.expiresAt) return refused('expired_token');
    if (grant.slowDown) {
      grant.slowDown = false;
      return refused('slow_down');
    }
    if (grant.declined) return refused('authorization_declined');
    if (!grant.user) return refused('authorization_pending');
    grants.delete(code);
    return tokensFor({ ...grant, user: grant.user });
  }

  /** An access token, and a new refresh token when the sign-in asked for `offline_access`. */
  function tokensFor(signedIn: SignedIn): Answer {
    const offline = signedIn.scope.split(' ').includes('offline_access');
    const access = random();
    accessTokens.set(access, {
      user: signedIn.user,
      expiresAt: Date.now() + signedIn.lifetime * 1000,
    });
    const refresh = random();
    if (offline) refreshTokens.set(refresh, signedIn);
    return {
      body: {
        token_type: 'Bearer',
        scope: signedIn.scope,
        expires_in: signedIn.lifetime,
        access_token: access,
        ...(offline ? { refresh_token: refresh } : {}),
      },
      user: signedIn.user,
    };
  }

  const refused = (code: string): Answer => ({
    body: { error: code, error_description: code },
    status: 400,
  });

  return { fetch, userOf };
}
