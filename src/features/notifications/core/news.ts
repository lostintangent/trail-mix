import type { Envelope, MessageRef, SyncEvent } from '../../mail/core/index.ts';

/**
 * How far an Inbox has been read for news: the highest UID judged so far, under the UIDVALIDITY it
 * was judged under. A server gives each new message a UID above every one before it, so anything
 * above the mark arrived since.
 */
export type Mark = { uidValidity: number; uid: number };

/** How long after its date a message can still be news. Old mail turning up late stays quiet. */
const NEWS_FOR_MS = 24 * 60 * 60_000;

/**
 * The news in one batch of an Inbox's sync, and the Inbox's mark after it. A batch that starts the
 * Inbox over, as every provider's first sync does and a server renumbering it, has no news: it only
 * sets the mark, so a first sync, a new account or a renumbered folder never floods. After that, a
 * message is news when the server reports it unseen, above the mark, or anywhere if the Inbox had
 * no mail to mark, dated within a day, and not moved there by the member, as an undone archive is.
 * A renumbered Inbox's mark starts again under its new UIDVALIDITY.
 */
export function newsIn(
  events: readonly SyncEvent[],
  mark: Mark | undefined,
  { now, movedIn }: { now: number; movedIn: (ref: MessageRef) => boolean },
): { news: Envelope[]; mark: Mark | undefined } {
  const arrived = events.flatMap((event) => (event.type === 'message' ? [event.envelope] : []));
  const startsOver = events.some(({ type }) => type === 'reset');
  const news = arrived.filter(
    (envelope) =>
      !startsOver &&
      (mark === undefined || envelope.uid > mark.uid) &&
      !envelope.flags.seen &&
      now - Date.parse(envelope.date) < NEWS_FOR_MS &&
      !movedIn(envelope),
  );
  return { news, mark: arrived.reduce(raised, mark) };
}

const raised = (mark: Mark | undefined, { uidValidity, uid }: Envelope): Mark =>
  mark?.uidValidity === uidValidity
    ? { uidValidity, uid: Math.max(mark.uid, uid) }
    : { uidValidity, uid };
