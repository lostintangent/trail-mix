/**
 * The server's own reason for a refusal, as a sentence. The Mailroom passes it on as the error's
 * message. A request that never reached the server has no reason of its own, and the browser's
 * words for it, which differ from browser to browser, say only that the fetch failed.
 */
export function reasonOf(
  error: unknown,
  isOnline = typeof navigator === 'undefined' || navigator.onLine,
): string {
  if (isUnreached(error)) {
    return isOnline ? 'Trail Mix couldn’t reach its server.' : 'This device is offline.';
  }
  const reason = error instanceof Error ? error.message.trim() : '';
  if (!reason) return 'The mail server gave no reason.';
  return /[.!?]$/.test(reason) ? reason : `${reason}.`;
}

/** Whether a request got no answer at all, which the browser reports as a fetch that failed. */
export function isUnreached(error: unknown): boolean {
  return error instanceof TypeError && UNREACHED.test(error.message.trim());
}

/** What Chromium, Firefox and Safari say when a fetch gets no answer. */
const UNREACHED =
  /^(?:Failed to fetch|NetworkError when attempting to fetch resource\.|Load failed)$/;
