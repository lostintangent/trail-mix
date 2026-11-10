import type { Endpoint } from './presets.ts';

/**
 * Why a host turned a sign-in away, in words a member can read. A host that answered is quoted as
 * it answered, and one that never did is named with its port, since a mistyped name or port is the
 * likely cause. The password never appears, even if a host repeats what it was sent.
 *
 * `failure` is what the IMAP or SMTP client rejected with: whether the host refused the
 * credentials, and the host's reply when it gave one.
 */
export function signInFailure(
  failure: { authenticationFailed?: boolean; code?: string; response?: string },
  { host, port }: Endpoint,
  credentials: { user: string; password: string },
): string {
  // An IMAP reply starts with its tag and status, which say nothing to a member.
  const reply = failure.response?.trim().replace(/^(?:\*|[\w.]+) (?:NO|BAD|BYE) /i, '');
  if (!reply) {
    return failure.authenticationFailed || failure.code === 'EAUTH'
      ? `${host} refused the password.`
      : `Trail Mix couldn’t reach ${host} on port ${port}.`;
  }
  const said = withoutSecrets(reply, credentials);
  return failure.authenticationFailed || failure.code === 'EAUTH'
    ? `${host} refused the password: ${said}`
    : `${host} refused the sign-in: ${said}`;
}

/** `text` without the password, plainly or in the encodings a sign-in sends it in. */
function withoutSecrets(text: string, { user, password }: { user: string; password: string }) {
  if (!password) return text;
  const forms = [password, base64(password), base64(`\0${user}\0${password}`)];
  return forms.reduce((out, form) => out.split(form).join('…'), text);
}

function base64(text: string) {
  return btoa(
    Array.from(new TextEncoder().encode(text), (byte) => String.fromCharCode(byte)).join(''),
  );
}
