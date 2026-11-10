/**
 * What a failed SMTP submission means for sending the message again. Up to the server's go-ahead
 * for the message body, nothing can have been delivered. After it, a reply still says what the
 * server did, but a connection lost before the reply leaves no way to know.
 *
 * `failure` is what the SMTP client rejected with: a code such as `ECONNECTION` and, when the server
 * answered, its reply and reply code. `bodySent` is whether the server had said to send the body.
 */
export function submitFailure(
  failure: { message?: string; code?: string; responseCode?: number; response?: string },
  bodySent: boolean,
  host: string,
): { error: string; passing: boolean } {
  const reply = failure.response?.trim() || failure.message || 'no reason given';
  if (failure.responseCode !== undefined && failure.responseCode >= 400) {
    // A 4xx is the server saying not now, and it keeps nothing it said that to.
    return failure.responseCode < 500
      ? { error: `${host} can’t take it right now: ${reply}`, passing: true }
      : { error: `${host} refused it: ${reply}`, passing: false };
  }
  if (bodySent) {
    return {
      error: `The connection to ${host} was lost after the message went out, so it may have been delivered. Retry sends it again.`,
      passing: false,
    };
  }
  if (failure.code !== undefined && REFUSALS.has(failure.code)) {
    return { error: `${host} refused it: ${reply}`, passing: false };
  }
  return { error: `Couldn’t reach ${host}: ${reply}`, passing: true };
}

/** Failures with no reply that trying again cannot fix: sign-in, configuration and the message. */
const REFUSALS = new Set([
  'EAUTH',
  'ENOAUTH',
  'EOAUTH2',
  'ECONFIG',
  'EENVELOPE',
  'EMESSAGE',
  'EMAXRECIPIENTS',
]);
