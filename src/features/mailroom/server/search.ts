import {
  applySyncEvent,
  sameRef,
  type AccountId,
  type ConversationId,
  type ConversationSummary,
  type Envelope,
  type Message,
  type MessageRef,
} from '../../mail/core/index.ts';
import type { MailProvider } from '../../providers/index.ts';
import type { Page, PageAt } from '../client/contract.ts';
import type { AccountBook } from './accounts.ts';
import { matchedRow, pageAfter, type EnvelopeIndex } from './envelope-index.ts';
import { report } from './report.ts';

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

/**
 * The member's last full-text search, asked of every folder of every account's server. Only memory
 * holds it, so a restart forgets it, and a hit it found outside the index opens until the next.
 */
export type FullTextSearch = ReturnType<typeof fullTextSearch>;

export function fullTextSearch(ports: {
  book: Pick<AccountBook, 'all'>;
  store: EnvelopeIndex;
  provider: (account: AccountId) => Promise<MailProvider>;
}) {
  const { store } = ports;
  let found: Found | undefined;

  /** Asks every folder of every account's server, and keeps what they found apart from the index. */
  const searchServers = async (text: string): Promise<Found> => {
    const hits = await Promise.all(
      ports.book.all().map(async ({ id }) => {
        const each: Envelope[] = [];
        try {
          const provider = await ports.provider(id);
          for (const { path } of store.folders(id)) {
            // A folder the server won't search leaves out its hits, and the rest still count.
            each.push(
              ...(await provider.search(path, text).catch((error: unknown) => {
                report(error);
                return [];
              })),
            );
          }
        } catch (error) {
          report(error);
        }
        return each;
      }),
    );
    return foundOf(text, hits.flat(), store);
  };

  return {
    /**
     * A page of what the servers found for `text`. The first page asks them again. Pages further
     * down, and a page around a result, read what that one found.
     */
    async page(text: string, at: PageAt): Promise<Page> {
      if (at === 0 || found?.text !== text) found = await searchServers(text);
      return pageAfter(found.rows, at);
    },

    /** A conversation as it opens, with any hit of the last search outside the index in it. */
    conversation: (id: ConversationId): Message[] => opened(id, store, found?.outside ?? []),

    /** A message the index holds, or the last full-text search found. */
    known: (ref: MessageRef): Message | undefined =>
      store.reads.message(ref) ?? found?.outside.find((hit) => sameRef(hit, ref)),

    /** Forgets the last search, as removing an account or erasing does. */
    forget() {
      found = undefined;
    },
  };
}

export function foundOf(
  text: string,
  hits: readonly Envelope[],
  store: Pick<EnvelopeIndex, 'reads' | 'conversation' | 'summaryOf'>,
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
      const summary = store.summaryOf(id, opened(id, store, outside));
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
