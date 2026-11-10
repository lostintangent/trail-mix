import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';

/**
 * The sign-in seam: how the Worker proves who sent a request. It is the only module that knows
 * how sign-in works, so a passkey sign-in could replace Cloudflare Access here and nowhere else.
 */

/** What a deployment's configuration says about sign-in. Every value is the operator's. */
export type SignInConfig = {
  /** The Cloudflare Access team domain, such as `example.cloudflareaccess.com`. */
  ACCESS_TEAM_DOMAIN?: string;
  /** The audience tag of the Access application in front of Trail Mix. */
  ACCESS_AUD?: string;
  /** The one development member, set only in the local `.dev.vars` file. */
  DEV_MEMBER?: string;
};

/** Proves who sent a request: their verified email address, or nothing. */
export type SignIn = (request: Request) => Promise<string | undefined>;

/**
 * How this deployment signs a request in: through Cloudflare Access once it is configured, as the
 * development member on localhost before that, or not at all, which keeps the deployment closed.
 * Tests hand in the keys Access signs with, which production fetches from the team domain.
 */
export function signInFor(config: SignInConfig, keys?: JWTVerifyGetKey): SignIn | undefined {
  const { ACCESS_TEAM_DOMAIN: team, ACCESS_AUD: audience, DEV_MEMBER: developer } = config;
  if (team && audience) return accessSignIn(team, audience, keys ?? certificatesOf(team));
  if (signsInDevelopers(config) && developer) return developmentSignIn(developer);
  return undefined;
}

/**
 * Whether this deployment signs in its development member, which only a developer's machine
 * does: no Access, and `DEV_MEMBER` set. Anything meant for a developer alone hangs on this.
 */
export function signsInDevelopers(config: SignInConfig): boolean {
  const { ACCESS_TEAM_DOMAIN: team, ACCESS_AUD: audience, DEV_MEMBER: developer } = config;
  return !(team && audience) && Boolean(developer);
}

/**
 * Access checks the person at its edge and hands the Worker a token it signed that names them.
 * Only a token Access signed for this application, still in date, names anyone. Every other header
 * a browser sends is its own say-so, so none of them is read.
 */
function accessSignIn(team: string, audience: string, keys: JWTVerifyGetKey): SignIn {
  return async (request) => {
    const token = request.headers.get('Cf-Access-Jwt-Assertion');
    if (!token) return undefined;
    try {
      const { payload } = await jwtVerify(token, keys, {
        issuer: `https://${team}`,
        audience,
        algorithms: ['RS256'],
      });
      return typeof payload.email === 'string' ? memberOf(payload.email) : undefined;
    } catch {
      return undefined;
    }
  };
}

/**
 * On a developer's machine there is one member, and only for requests addressed to localhost. The
 * address comes from the Host header, which any client sets, so this holds only while the dev
 * server listens on loopback alone, as it does unless started with `--host`. Workerd can't help:
 * it sees every request arrive from Vite, as 127.0.0.1, whoever sent it.
 */
function developmentSignIn(developer: string): SignIn {
  return (request) =>
    Promise.resolve(LOCALHOST.has(new URL(request.url).hostname) ? memberOf(developer) : undefined);
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
