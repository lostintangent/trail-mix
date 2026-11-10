import type { Endpoint } from './presets.ts';

/** What a sign-in sent: who, and the password or each access token it was given. */
export type SentCredentials = { user: string; by: 'password' | 'token'; secrets: string[] };

/**
 * Why a host turned a sign-in away, in words a member can read. A host that answered is quoted as
 * it answered, and one that never did is named with its port, since a mistyped name or port is the
 * likely cause. No password or token appears, even if a host repeats what it was sent.
 *
 * `failure` is what the IMAP or SMTP client rejected with: whether the host refused the
 * credentials, and the host's reply when it gave one.
 */
export function signInFailure(
  failure: { authenticationFailed?: boolean; code?: string; response?: string },
  { host, port }: Endpoint,
  credentials: SentCredentials,
): string {
  const refused = failure.authenticationFailed || failure.code === 'EAUTH';
  const what = credentials.by === 'password' ? 'the password' : 'the sign-in';
  // An IMAP reply starts with its tag and status, which say nothing to a member.
  const reply = failure.response?.trim().replace(/^(?:\*|[\w.]+) (?:NO|BAD|BYE) /i, '');
  if (!reply) {
    return refused
      ? `${host} refused ${what}.`
      : `Trail Mix couldn’t reach ${host} on port ${port}.`;
  }
  const said = withoutSecrets(reply, credentials);
  return refused ? `${host} refused ${what}: ${said}` : `${host} refused the sign-in: ${said}`;
}

/**
 * `text` without any secret, plainly or in the encodings a sign-in sends it in: AUTH PLAIN's, and
 * XOAUTH2's for a token.
 */
function withoutSecrets(text: string, { user, secrets }: SentCredentials) {
  const forms = secrets
    .filter(Boolean)
    .flatMap((secret) => [
      secret,
      base64(secret),
      base64(`\0${user}\0${secret}`),
      base64(`user=${user}\x01auth=Bearer ${secret}\x01\x01`),
    ]);
  return forms.reduce((out, form) => out.split(form).join('…'), text);
}

function base64(text: string) {
  return btoa(
    Array.from(new TextEncoder().encode(text), (byte) => String.fromCharCode(byte)).join(''),
  );
}
