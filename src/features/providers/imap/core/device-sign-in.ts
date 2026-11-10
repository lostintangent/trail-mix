/**
 * Signing in at a vendor instead of with a password: OAuth's device authorization grant (RFC 8628),
 * then refresh tokens. The member reads a short code in Trail Mix and enters it on the vendor's own
 * page, so there is no callback route. This module builds each request and reads each answer. Who
 * sends them, and when, is the Mailroom's.
 *
 * A vendor's words reach the member as it said them, without the trace and correlation IDs
 * Microsoft adds, and every reason names the vendor from its preset, never from here.
 */

/** A vendor's sign-in: who it is, where its codes and tokens come from, and what they open. */
export type DeviceSignIn = {
  /** The vendor as a member knows it, such as Microsoft. */
  vendor: string;
  /** What the paths are on. Only a test replaces it, with a stand-in on its own machine. */
  authority: string;
  codePath: string;
  tokenPath: string;
  scopes: readonly string[];
};

/** A form-encoded POST to a vendor. */
export type Request = { url: string; body: URLSearchParams };

/** A vendor's answer: its HTTP status, and its body as JSON, or null when it sent none. */
export type Answer = { status: number; body: unknown };

/** What a sign-in starts with. `deviceCode` redeems the tokens, so only the Mailroom holds it. */
export type DeviceCode = {
  deviceCode: string;
  /** What the member enters at `link`. */
  code: string;
  link: string;
  /** Milliseconds since the epoch, as are all the times here. */
  expiresAt: number;
  /** How long to wait between polls. */
  interval: number;
};

export type Tokens = { access: string; refresh: string; expiresAt: number };

/** What one poll came to: wait this long and ask again, signed in, or stopped for a reason. */
export type Polled = { pending: number } | { granted: Tokens } | { refused: string };

/**
 * What one refresh came to. `lapsed` when only the member signing in again will do, as after 90 idle
 * days, a changed password or revoked consent. `failed` when asking again later may work.
 */
export type Refreshed = { granted: Tokens } | { lapsed: string } | { failed: string };

export const EXPIRED = 'The code expired before you signed in.';

/** An access token is used until this long before it expires, so none runs out mid-command. */
export const FRESH_MARGIN_MS = 5 * 60_000;

/** RFC 8628's defaults, for a vendor that leaves them out. */
const CODE_SECONDS = 900;
const INTERVAL_SECONDS = 5;
/** What RFC 8628 has a client add to its interval each time it's told to slow down. */
const SLOW_DOWN_MS = 5000;
/** Access tokens last an hour unless the vendor says otherwise. */
const TOKEN_SECONDS = 3600;

/** Refusals of a refresh that a new sign-in answers. Anything else may pass. */
const LAPSES = new Set([
  'invalid_grant',
  'interaction_required',
  'consent_required',
  'login_required',
]);

// The requests

export function codeRequest(signIn: DeviceSignIn, clientId: string): Request {
  return post(signIn.authority, signIn.codePath, {
    client_id: clientId,
    scope: signIn.scopes.join(' '),
  });
}

export function pollRequest(signIn: DeviceSignIn, clientId: string, deviceCode: string): Request {
  return post(signIn.authority, signIn.tokenPath, {
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    client_id: clientId,
    device_code: deviceCode,
  });
}

export function refreshRequest(signIn: DeviceSignIn, clientId: string, refresh: string): Request {
  return post(signIn.authority, signIn.tokenPath, {
    grant_type: 'refresh_token',
    client_id: clientId,
    refresh_token: refresh,
    scope: signIn.scopes.join(' '),
  });
}

// The answers

/** The code a sign-in starts with. Throws why, in the vendor's words, when it gives none. */
export function codeFrom(signIn: DeviceSignIn, answer: Answer, now: number): DeviceCode {
  const body = fields(answer.body);
  const deviceCode = text(body.device_code);
  const code = text(body.user_code);
  // RFC 8628 says verification_uri, and some vendors, Zoho among them, verification_url.
  const link = text(body.verification_uri) ?? text(body.verification_url);
  if (!ok(answer) || !deviceCode || !code || !link) {
    throw new Error(`${signIn.vendor} refused to start signing in: ${said(body)}`);
  }
  if (!isPage(link)) {
    throw new Error(`${signIn.vendor} gave a sign-in page Trail Mix won’t open: ${link}`);
  }
  return {
    deviceCode,
    code,
    link,
    expiresAt: now + seconds(body.expires_in, CODE_SECONDS) * 1000,
    interval: seconds(body.interval, INTERVAL_SECONDS) * 1000,
  };
}

/** What a poll came to, given the interval it waited. */
export function polled(
  signIn: DeviceSignIn,
  answer: Answer,
  interval: number,
  now: number,
): Polled {
  const body = fields(answer.body);
  if (ok(answer)) {
    const tokens = tokensFrom(body, undefined, now);
    return tokens
      ? { granted: tokens }
      : { refused: `${signIn.vendor} signed you in, but gave Trail Mix no way to stay signed in.` };
  }
  switch (body.error) {
    case 'authorization_pending':
      return { pending: interval };
    case 'slow_down':
      return { pending: interval + SLOW_DOWN_MS };
    case 'authorization_declined':
    case 'access_denied':
      return { refused: `You declined the sign-in at ${signIn.vendor}.` };
    case 'expired_token':
      return { refused: EXPIRED };
    default:
      return { refused: `${signIn.vendor} refused the sign-in: ${said(body)}` };
  }
}

/** What a refresh came to. A vendor may keep the refresh token it was given, and then it's kept. */
export function refreshed(
  signIn: DeviceSignIn,
  answer: Answer,
  held: string,
  now: number,
): Refreshed {
  const body = fields(answer.body);
  if (ok(answer)) {
    const tokens = tokensFrom(body, held, now);
    return tokens ? { granted: tokens } : { failed: `${signIn.vendor} sent no access token.` };
  }
  const reason = `${signIn.vendor} refused to keep you signed in: ${said(body)}`;
  return typeof body.error === 'string' && LAPSES.has(body.error)
    ? { lapsed: reason }
    : { failed: reason };
}

/** Whether a token can still be used, with room to spare. */
export const isFresh = (tokens: Pick<Tokens, 'expiresAt'>, now: number) =>
  now < tokens.expiresAt - FRESH_MARGIN_MS;

// Reading what vendors send

function tokensFrom(body: Fields, held: string | undefined, now: number): Tokens | undefined {
  const access = text(body.access_token);
  const refresh = text(body.refresh_token) ?? held;
  if (!access || !refresh) return undefined;
  return { access, refresh, expiresAt: now + seconds(body.expires_in, TOKEN_SECONDS) * 1000 };
}

/**
 * Why a vendor refused, in its words. Microsoft's description runs on, a line each, to a trace ID, a
 * correlation ID and a timestamp, which say nothing to a member.
 */
function said(body: Fields): string {
  const description = text(body.error_description)?.split(/\r?\n/)[0]?.trim();
  return description || text(body.error) || 'it gave no reason.';
}

type Fields = Record<string, unknown>;

const fields = (body: unknown): Fields =>
  typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as Fields) : {};

const text = (value: unknown) => (typeof value === 'string' && value ? value : undefined);

const ok = (answer: Answer) => answer.status >= 200 && answer.status < 300;

function seconds(value: unknown, fallback: number): number {
  const given = typeof value === 'string' ? Number(value) : value;
  return typeof given === 'number' && Number.isFinite(given) && given > 0 ? given : fallback;
}

/** A page a browser may open: https, or plain http on this machine, as a test's stand-in serves. */
function isPage(link: string): boolean {
  const url = urlOf(link);
  return url?.protocol === 'https:' || (url?.protocol === 'http:' && isLoopback(url));
}

/**
 * The sign-in, at `standIn` instead when that names this machine, as only a test's stand-in does.
 * Anything else is ignored, so a deployment's tokens only ever go to the vendor itself.
 */
export function withStandIn(signIn: DeviceSignIn, standIn: string | undefined): DeviceSignIn {
  const url = standIn ? urlOf(standIn) : undefined;
  if (!standIn || !url || !['http:', 'https:'].includes(url.protocol) || !isLoopback(url)) {
    return signIn;
  }
  return { ...signIn, authority: standIn };
}

/** Whether a URL names this machine: its exact host name, and no user name to dress another as it. */
function isLoopback(url: URL): boolean {
  return (
    ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) && !url.username && !url.password
  );
}

function urlOf(text: string): URL | undefined {
  try {
    return new URL(text);
  } catch {
    return undefined;
  }
}

function post(authority: string, path: string, form: Record<string, string>): Request {
  return { url: `${authority.replace(/\/$/, '')}${path}`, body: new URLSearchParams(form) };
}
