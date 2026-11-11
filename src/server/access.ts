import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';

/**
 * The sign-in seam: how the Worker proves who sent a request. It is the only module that knows
 * how sign-in works, so a passkey sign-in could replace Cloudflare Access here and nowhere else.
 * A deployment signs in one of three ways: members through Cloudflare Access, visitors to the
 * public demo by a cookie the demo signs, or the one development member on a developer's machine.
 */

/** What a deployment's configuration says about sign-in. Every value is the operator's. */
export type SignInConfig = {
  /** The Cloudflare Access team domain, such as `example.cloudflareaccess.com`. */
  ACCESS_TEAM_DOMAIN?: string;
  /** The audience tag of the Access application in front of Trail Mix. */
  ACCESS_AUD?: string;
  /** The one development member, set only in the local `.dev.vars` file. */
  DEV_MEMBER?: string;
  /**
   * The key the public demo signs each visitor's cookie with, a secret only the demo holds. It
   * signs visitors in only where the deployment serves nothing but the demo mailbox, and has a gate.
   */
  VISITOR_KEY?: string;
  /** Set where the deployment serves only the demo mailbox, as previews and the demo do. */
  DEMO_MAILBOX?: string;
  /** The demo's gate, which says whether a new visitor may come in. */
  VISITOR_GATE?: VisitorGate;
};

/** Says whether a new visitor may come in, by their id and the network they come from. */
export type VisitorGate = { admit(visitor: string, network: string): Promise<boolean> };

/**
 * Someone proved: their verified email address, and a cookie their response must set to stay
 * signed in, where sign-in keeps one.
 */
export type Signed = { member: string; setCookie?: string };

/**
 * Proves who sent a request, or answers it in their place, saying why nobody could be named. A
 * request that reaches the member's Mailroom, and so may make one, says so.
 */
export type SignIn = (
  request: Request,
  asking: { reachesMailroom: boolean },
) => Promise<Signed | Response>;

/**
 * How this deployment signs a request in: through Cloudflare Access once it is configured, as a
 * visitor on the public demo, as the development member on localhost, or not at all, which keeps
 * the deployment closed. Tests hand in the keys Access signs with, which production fetches from
 * the team domain.
 */
export function signInFor(config: SignInConfig, keys?: JWTVerifyGetKey): SignIn | undefined {
  const { ACCESS_TEAM_DOMAIN: team, ACCESS_AUD: audience, DEV_MEMBER: developer } = config;
  if (team && audience) return accessSignIn(team, audience, keys ?? certificatesOf(team));
  if (signsInVisitors(config)) return visitorSignIn(config.VISITOR_KEY!, config.VISITOR_GATE!);
  if (signsInDevelopers(config) && developer) return developmentSignIn(developer);
  return undefined;
}

/**
 * Whether this deployment signs in its development member, which only a developer's machine
 * does: no Access, no visitors, and `DEV_MEMBER` set. Anything meant for a developer alone hangs
 * on this.
 */
export function signsInDevelopers(config: SignInConfig): boolean {
  const { ACCESS_TEAM_DOMAIN: team, ACCESS_AUD: audience, DEV_MEMBER: developer } = config;
  return !(team && audience) && !signsInVisitors(config) && Boolean(developer);
}

/**
 * Whether this deployment is the public demo, which signs in anyone as a visitor: its key and its
 * gate are set, Access isn't, and it serves only the demo mailbox, which can't connect a real
 * account.
 */
export function signsInVisitors(config: SignInConfig): boolean {
  const { ACCESS_TEAM_DOMAIN: team, ACCESS_AUD: audience } = config;
  return (
    !(team && audience) &&
    Boolean(config.VISITOR_KEY) &&
    Boolean(config.DEMO_MAILBOX) &&
    config.VISITOR_GATE !== undefined
  );
}

/** Why Access named nobody: a request it didn't sign, or one for another application. */
const notSignedIn = () => new Response('Sign in through Cloudflare Access.', { status: 401 });

/**
 * Access checks the person at its edge and hands the Worker a token it signed that names them.
 * Only a token Access signed for this application, still in date, names anyone. Every other header
 * a browser sends is its own say-so, so none of them is read.
 */
function accessSignIn(team: string, audience: string, keys: JWTVerifyGetKey): SignIn {
  return async (request) => {
    const token = request.headers.get('Cf-Access-Jwt-Assertion');
    if (!token) return notSignedIn();
    try {
      const { payload } = await jwtVerify(token, keys, {
        issuer: `https://${team}`,
        audience,
        algorithms: ['RS256'],
      });
      return typeof payload.email === 'string'
        ? { member: memberOf(payload.email) }
        : notSignedIn();
    } catch {
      return notSignedIn();
    }
  };
}

/** The cookie a visitor is known by, sent only to this host, over HTTPS, and never to scripts. */
const VISITOR_COOKIE = '__Host-visitor';

/**
 * How long a visitor's cookie lasts after their last request: under the demo's day, less the hour
 * an opening may go unnoted, so it always ends before their Mailroom erases itself, and nobody
 * comes back to an empty one.
 */
export const VISITOR_SECONDS = 22 * 60 * 60;

/** Visitors are named on a domain reserved never to exist, so no visitor is anyone's address. */
const VISITOR_DOMAIN = 'demo.invalid';

/**
 * On the public demo anyone may come in, each as a visitor of their own. A visitor is a random id
 * in a cookie the demo signs with its key, named as that id on `demo.invalid`. A browser can drop
 * its cookie and come back as a new visitor, but without the key it can't name another.
 *
 * Serving the page only gives a new visitor their cookie. Their first request that reaches a
 * Mailroom, which makes one, asks the gate first, and the cookie then says they're in, so the gate
 * is asked once a visitor. When the gate says no, the demo is full for now, and no Mailroom is
 * made. Each answer sets the cookie again, so a visitor stays one while they keep coming back.
 */
function visitorSignIn(secret: string, gate: VisitorGate): SignIn {
  if (secret.length < 32) throw new Error('VISITOR_KEY must be at least 32 characters.');
  return async (request, { reachesMailroom }) => {
    const key = await visitorKey(secret);
    const held = await heldVisitor(request, key);
    const id = held?.id ?? newVisitorId();
    let isIn = held?.isIn ?? false;
    if (reachesMailroom && !isIn) {
      const network = networkOf(request.headers.get('CF-Connecting-IP') ?? '');
      if (!(await gate.admit(id, network))) return fullForNow();
      isIn = true;
    }
    const value = `${id}.${isIn ? IN : NEW}`;
    const signature = new Uint8Array(await crypto.subtle.sign('HMAC', key, signed(value)));
    return {
      member: `${id}@${VISITOR_DOMAIN}`,
      setCookie: `${VISITOR_COOKIE}=${value}.${base64Url(signature)}; Max-Age=${VISITOR_SECONDS}; Path=/; Secure; HttpOnly; SameSite=Lax`,
    };
  };
}

/** What a visitor's cookie says of the gate: they're in, or they haven't asked it yet. */
const IN = 'in';
const NEW = 'new';

const newVisitorId = () =>
  [...crypto.getRandomValues(new Uint8Array(16))]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');

/** The visitor a request's cookie names, and whether the gate let them in, if the demo signed it. */
async function heldVisitor(
  request: Request,
  key: CryptoKey,
): Promise<{ id: string; isIn: boolean } | undefined> {
  const value = (request.headers.get('Cookie') ?? '')
    .split(';')
    .map((pair) => pair.trim())
    .find((pair) => pair.startsWith(`${VISITOR_COOKIE}=`))
    ?.slice(VISITOR_COOKIE.length + 1);
  const [, id, state, signature] =
    /^([0-9a-f]{32})\.(in|new)\.([\w-]{43})$/.exec(value ?? '') ?? [];
  if (!id || !state || !signature) return undefined;
  const bytes = Uint8Array.from(atob(signature.replace(/-/g, '+').replace(/_/g, '/')), (c) =>
    c.charCodeAt(0),
  );
  const isSigned = await crypto.subtle.verify('HMAC', key, bytes, signed(`${id}.${state}`));
  return isSigned ? { id, isIn: state === IN } : undefined;
}

/** What the demo signs for a visitor, so its signature can't stand for anything else. */
const signed = (value: string) => new TextEncoder().encode(`trail-mix visitor ${value}`);

/**
 * The network a visitor comes from, which the gate's limit a minute counts by: an IPv4 address, or
 * an IPv6 address's /64, since one machine commonly holds a whole /64.
 */
export function networkOf(address: string): string {
  if (!address.includes(':')) return address;
  const [head = '', tail = ''] = address.toLowerCase().split('::');
  const before = head ? head.split(':') : [];
  const after = tail ? tail.split(':') : [];
  const zeros = Array<string>(Math.max(0, 8 - before.length - after.length)).fill('0');
  const groups = [...before, ...zeros, ...after].slice(0, 4);
  return `${groups.map((group) => group.replace(/^0+(?=.)/, '')).join(':')}::/64`;
}

/** The demo's answer once it has let in all it takes for now, in the setup page's voice. */
function fullForNow(): Response {
  const page = `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="color-scheme" content="light dark">
<title>Trail Mix’s demo is full for now</title>
<body style="font-family: system-ui; max-width: 36rem; margin: 4rem auto; padding: 0 1rem">
<h1>Trail Mix’s demo is full for now</h1>
<p>It lets in only so many new visitors at a time. Try again in a while, or deploy a Trail Mix of your own.</p>
</body>
</html>`;
  return new Response(page, {
    status: 429,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Retry-After': '60' },
  });
}

/** The demo's signing key, made once per key while the isolate lives. */
const visitorKeys = new Map<string, Promise<CryptoKey>>();
function visitorKey(secret: string): Promise<CryptoKey> {
  let key = visitorKeys.get(secret);
  if (!key) {
    key = crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign', 'verify'],
    );
    visitorKeys.set(secret, key);
  }
  return key;
}

const base64Url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

/**
 * On a developer's machine there is one member, and only for requests addressed to localhost. The
 * address comes from the Host header, which any client sets, so this holds only while the dev
 * server listens on loopback alone, as it does unless started with `--host`. Workerd can't help:
 * it sees every request arrive from Vite, as 127.0.0.1, whoever sent it.
 */
function developmentSignIn(developer: string): SignIn {
  return (request) =>
    Promise.resolve(
      LOCALHOST.has(new URL(request.url).hostname)
        ? { member: memberOf(developer) }
        : notSignedIn(),
    );
}

const LOCALHOST = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * One person, one Mailroom, however their address is capitalized. Only A to Z fold, since
 * `toLowerCase` would also fold other scripts onto ASCII, such as the Kelvin sign onto `k`.
 */
const memberOf = (email: string) =>
  email.trim().replace(/[A-Z]/g, (letter) => letter.toLowerCase());

/** Access's signing keys, fetched from the team domain and kept while the isolate lives. */
const certificates = new Map<string, JWTVerifyGetKey>();
function certificatesOf(team: string): JWTVerifyGetKey {
  let keys = certificates.get(team);
  if (!keys) {
    keys = createRemoteJWKSet(new URL(`https://${team}/cdn-cgi/access/certs`));
    certificates.set(team, keys);
  }
  return keys;
}
