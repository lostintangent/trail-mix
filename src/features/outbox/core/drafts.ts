import { sameRef, type ConversationId, type MessageRef } from '../../mail/core/index.ts';
import { conversationOf, isAway, type Leaving } from './leaving.ts';

/**
 * Mail on its way stays out of Drafts, from the press of Send until its draft has gone from the
 * server's Drafts folder: out of the Drafts list, by its conversation, and out of the Drafts count.
 * A send that fails, or is undone, is a draft again.
 *
 * The count is harder. A folder's count is the server's, listed again after each sync of the
 * folder, so it counts a draft only from the listing after the draft was saved, and still counts it
 * after the send has left the Outbox, until the listing after the Drafts folder's next sync. So a
 * device follows, for each send, the most its Drafts folder has counted since the send began: once
 * the count falls from there, the draft has left it.
 */

/**
 * The conversations the Drafts view leaves out: each whose drafts are all on their way. `draftsIn`
 * gives a conversation's drafts as this device last saw them, if it has seen it. One it hasn't
 * holds only the draft on its way, as a new message does.
 */
export function awayFromDrafts(
  all: readonly Leaving[],
  draftsIn: (conversation: ConversationId) => readonly MessageRef[] | undefined,
): ReadonlySet<ConversationId> {
  const away = all.filter(isAway);
  const conversations = new Set(away.flatMap((leaving) => conversationOf(leaving) ?? []));
  const isOnItsWay = (draft: MessageRef) => away.some((leaving) => sameRef(leaving.draft, draft));
  return new Set(
    [...conversations].filter((conversation) => (draftsIn(conversation) ?? []).every(isOnItsWay)),
  );
}

/** The most a send's Drafts folder has counted since the send began. */
export type Peak = { draft: MessageRef; count: number };

/**
 * What a device has seen of each send's Drafts folder, given the folders' counts now. `countOf`
 * gives the count of a draft's folder, if it is a Drafts folder the device knows. A send no longer
 * followed is forgotten, so one sent again starts from the count it begins with.
 */
export function notePeaks(
  peaks: readonly Peak[],
  all: readonly Leaving[],
  countOf: (draft: MessageRef) => number | undefined,
): readonly Peak[] {
  const noted = all.flatMap(({ draft }): Peak[] => {
    const count = countOf(draft);
    if (count === undefined) return [];
    const was = peaks.find((peak) => sameRef(peak.draft, draft))?.count ?? count;
    return [{ draft, count: Math.max(was, count) }];
  });
  const isSame =
    noted.length === peaks.length &&
    noted.every(
      ({ draft, count }, at) => sameRef(draft, peaks[at]!.draft) && count === peaks[at]!.count,
    );
  return isSame ? peaks : noted;
}

/**
 * How many drafts on their way the Drafts folders' counts still hold. A send the Outbox holds has
 * its draft there. Of the sends gone from it, a folder holds as many as its count has not yet
 * fallen from the most it counted since the first of them began.
 */
export function draftsStillCounted(
  all: readonly Leaving[],
  peaks: readonly Peak[],
  countOf: (draft: MessageRef) => number | undefined,
): number {
  const away = all.filter((leaving) => isAway(leaving) && countOf(leaving.draft) !== undefined);
  const held = away.filter(({ seen }) => seen?.goneAt === undefined).length;
  const gone = Map.groupBy(
    away.filter(({ seen }) => seen?.goneAt !== undefined),
    ({ draft }) => JSON.stringify([draft.account, draft.path]),
  );
  return [...gone.values()].reduce((counted, sends) => {
    const count = countOf(sends[0]!.draft)!;
    const peak = Math.max(
      count,
      ...sends.map(({ draft }) => peaks.find((seen) => sameRef(seen.draft, draft))?.count ?? count),
    );
    return counted + Math.max(0, sends.length - (peak - count));
  }, held);
}
