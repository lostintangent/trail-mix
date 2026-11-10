import {
  applySyncEvent,
  type ConversationId,
  type ConversationSummary,
  type Envelope,
  type Message,
  type MessageRef,
} from '../../mail/core/index.ts';
import { summaryOf, type EnvelopeIndex } from './envelope-index.ts';

/**
 * Full-text search: what the mail servers found, as rows a list shows. It reads the index to place
 * each hit in its conversation and writes nothing to it, since the index learns of mail only
 * through sync. A hit outside the index is remembered with the rows, so that it opens like any
 * other until the next full-text search replaces it.
 */
export type Found = {
  text: string;
  /** Newest first, one per conversation. */
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
  const conversations = new Set<ConversationId>();
  for (const hit of newest) {
    const held = store.reads.message(hit);
    if (held) {
      conversations.add(held.conversation);
      continue;
    }
    // The conversation the hit would join, worked out as the fold would and then set aside.
    const change = applySyncEvent(store.reads, { type: 'message', envelope: hit });
    const placed = change.put.find((message) => sameRef(message, hit));
    if (!placed) continue;
    outside.push(placed);
    conversations.add(placed.conversation);
  }
  const rows = [...conversations]
    .flatMap((id) => summaryOf(id, opened(id, store, outside)) ?? [])
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

export const sameRef = (a: MessageRef, b: MessageRef) =>
  a.account === b.account &&
  a.path === b.path &&
  a.uidValidity === b.uidValidity &&
  a.uid === b.uid;
