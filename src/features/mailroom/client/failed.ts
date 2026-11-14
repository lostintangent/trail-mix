import { isUnreached } from '../../../shared/reasons.ts';

/**
 * What failed when a call to the Mailroom did, in a line a member can pass on: the status the
 * Worker answered with and its reason, which is the Mailroom's own when the Mailroom failed, or that
 * no answer came at all, as when the network is down or a sign-in has lapsed. With no answer while
 * the browser says it's offline, that says why. Otherwise the browser's words are the only clue.
 */
export function whatFailed(
  error: unknown,
  isOffline = typeof navigator !== 'undefined' && navigator.onLine === false,
): string {
  if (isOffline && isUnreached(error)) return 'This device is offline.';
  const { status, message } = (typeof error === 'object' && error !== null ? error : {}) as {
    status?: unknown;
    message?: unknown;
  };
  // An error page arrives whole as the message, so only its words are kept, and only the first.
  const words = typeof message === 'string' ? message.replace(/<[^>]*>/g, ' ') : '';
  const said = words.replace(/\s+/g, ' ').trim();
  const reason = said.length > REASON_LENGTH ? `${said.slice(0, REASON_LENGTH - 1)}…` : said;
  if (typeof status !== 'number') return reason ? `No answer came: ${reason}` : 'No answer came.';
  return reason ? `Trail Mix answered ${status}: ${reason}` : `Trail Mix answered ${status}.`;
}

const REASON_LENGTH = 160;

/**
 * Whether the answer that came back for a failed call refused it, so that asking again would only
 * be refused again. The Mailroom's refusal comes whole, as the plain error the server function's
 * answer carries, and so does the Worker's, as when it turns away a call from another origin.
 * Nothing else says whether the call ran: no answer at all, one whose body never came whole, a
 * platform's error page, or the Worker's 503, which it answers when Cloudflare failed the call in a
 * way that may pass. A 429 asks to be asked again later, as the demo's limit on changes does.
 */
export function isRefusal(response: Pick<Response, 'status'> | undefined, error: unknown): boolean {
  if (!response || response.status >= 500 || response.status === 429) return false;
  // What the browser throws reading a body that never came whole is a TypeError or a SyntaxError.
  return error instanceof Error && Object.getPrototypeOf(error) === Error.prototype;
}
