import {
  applySyncEvent,
  sameRef,
  type ConversationId,
  type ConversationSummary,
  type Envelope,
  type Message,
} from '../../mail/core/index.ts';
import { matchedRow, summaryOf, type EnvelopeIndex } from './envelope-index.ts';

/**
 * Full-text search: what the mail servers found, as rows a list shows. It reads the index to place
 * each hit in its conversation and writes nothing to it, since the index learns of mail only
 * through sync. A hit outside the index is remembered with the rows, so that it opens like any
 * other until the next full-text search replaces it.
 */
export type Found = {
  text: string;
  /**
   * One per conversation, newest first by its newest hit and shown by that hit, as the index's own
   * search rows are.
   */
  rows: ConversationSummary[];
  /** The hits the index doesn't hold, each in the conversation it would join. */
  outside: Message[];
};

/** How many hits a full-text search keeps, the newest across every folder. */
export const FOUND_LIMIT = 200;

export function foundOf(
  text: string,
  hits: readonly Envelope[],
  store: Pick<EnvelopeIndex, 'reads' | 'conversation'>,
): Found {
  const newest = [...hits]
    .sort((a, b) => b.date.localeCompare(a.date) || b.uid - a.uid)
    .slice(0, FOUND_LIMIT);
  const outside: Message[] = [];
  // Each conversation's newest hit, since the hits are newest first.
  const shownBy = new Map<ConversationId, Envelope>();
  for (const hit of newest) {
    const held = store.reads.message(hit);
    if (held) {
      if (!shownBy.has(held.conversation)) shownBy.set(held.conversation, hit);
      continue;
    }
    // The conversation the hit would join, worked out as the fold would and then set aside.
    const change = applySyncEvent(store.reads, { type: 'message', envelope: hit });
    const placed = change.put.find((message) => sameRef(message, hit));
    if (!placed) continue;
    outside.push(placed);
    if (!shownBy.has(placed.conversation)) shownBy.set(placed.conversation, hit);
  }
  const rows = [...shownBy]
    .flatMap(([id, hit]) => {
      const summary = summaryOf(id, opened(id, store, outside));
      return summary ? [matchedRow(summary, hit)] : [];
    })
    .sort((a, b) => b.date.localeCompare(a.date) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
  return { text, rows, outside };
}

/** A conversation as it opens: what the index holds of it, and any hit outside the index in it. */
export function opened(
  id: ConversationId,
  store: Pick<EnvelopeIndex, 'conversation'>,
  outside: readonly Message[],
): Message[] {
  const indexed = store.conversation(id);
  const extra = outside.filter(
    (hit) => hit.conversation === id && !indexed.some((held) => sameRef(held, hit)),
  );
  return [...indexed, ...extra].sort((a, b) => a.date.localeCompare(b.date));
}
