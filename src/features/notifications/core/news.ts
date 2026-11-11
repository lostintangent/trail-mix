import type { Envelope, MessageRef, SyncEvent } from '../../mail/core/index.ts';

/**
 * How far an Inbox has been read for news: the highest UID judged so far, under the UIDVALIDITY it
 * was judged under. A server gives each new message a UID above every one before it, so anything
 * above the mark arrived since.
 */
export type Mark = { uidValidity: number; uid: number };

/** How long after its date a message can still be news. Old mail turning up late stays quiet. */
export const NEWS_FOR_MS = 24 * 60 * 60_000;

/**
 * The news in one batch of an Inbox's sync, and the Inbox's mark after it. A message is news when
 * the server reports it unseen, above the mark under the same UIDVALIDITY, dated within a day, and
 * not moved there by the member, as an undone archive is. An Inbox with no mark, or under a new
 * UIDVALIDITY, is being read for the first time, so nothing in it is news, and the mark starts at
 * its highest UID. A first sync, a new account or a server starting a folder over never floods.
 */
export function newsIn(
  events: readonly SyncEvent[],
  mark: Mark | undefined,
  { now, movedIn }: { now: number; movedIn: (ref: MessageRef) => boolean },
): { news: Envelope[]; mark: Mark | undefined } {
  const arrived = events.flatMap((event) => (event.type === 'message' ? [event.envelope] : []));
  const news = arrived.filter(
    (envelope) =>
      mark !== undefined &&
      envelope.uidValidity === mark.uidValidity &&
      envelope.uid > mark.uid &&
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
