import type {
  BundleId,
  BundleSummary,
  ConversationId,
  ConversationSummary,
  Message,
  View,
} from '../../mail/core/index.ts';
import {
  MATCHES_LISTED,
  PAGE_SIZE,
  type BundlePage,
  type Page,
  type PageAt,
} from '../client/contract.ts';
import { COLUMNS, itemIn, matchOf, messageIn, summaryIn, type Row } from './rows.ts';
import type { Sql, SqlValue } from './schema.ts';

/**
 * The lists the envelope index's rows make, read a page at a time: a view's, a bundle's and a
 * search's. They read the rows the fold keeps, and write nothing.
 */
export function listsIn(sql: Sql) {
  /**
   * One page of a list that merges `parts`, each a query of `id` and `date`, newest first and ties
   * by id, and how many rows they hold.
   */
  function listed(parts: readonly Part[], asked: PageAt, size: number): Page {
    const { rows, at } = pageOf(parts, asked, size);
    const [{ total } = { total: 0 }] = sql.all<{ total: number }>(
      `SELECT ${parts.map((part) => `(SELECT COUNT(*) FROM (${part.sql}))`).join(' + ')} AS total`,
      ...parts.flatMap((part) => part.params),
    );
    return { items: rows.map(itemIn), at, total };
  }

  /**
   * The query of a list's rows of one kind, as `id` and `date`: those `select` reads that meet every
   * condition in `where`, or, of a list of unread mail, the unread ones and beside them the read one
   * whose `key` is `keep`, which stays listed while it is open. Each is its own range of an index,
   * so the list still merges them newest first.
   */
  function part(
    { select, key, where, params }: PartOf,
    unread: { keep: string | undefined } | undefined,
  ): Part {
    const query = (...more: string[]) =>
      [select, [...where, ...more].join(' AND ')].filter(Boolean).join(' WHERE ');
    if (!unread) return { sql: query(), params };
    if (unread.keep === undefined) return { sql: query('unread = 1'), params };
    return {
      sql: `${query('unread = 1')} UNION ALL ${query('unread = 0', `${key} = ?`)}`,
      params: [...params, ...params, unread.keep],
    };
  }

  /**
   * The rows of one page of a list that merges `parts`, each a query of `id` and `date`, newest
   * first and ties by id, and where the page starts. A page asked at a place passes over the rows
   * above it. One asked around a row counts them instead, and reads outward from the row, so it
   * costs no more however deep the row lies.
   */
  function pageOf(
    parts: readonly Part[],
    asked: PageAt,
    size: number,
  ): { rows: { summary: string }[]; at: number } {
    const all = parts.map((part) => part.sql).join(' UNION ALL ');
    const each = parts.flatMap((part) => part.params);
    const row = typeof asked === 'number' ? undefined : rowAmong(parts, asked.around);
    const at = startOf(asked, size, () => row?.place);
    const summaries = (page: string, ...bound: SqlValue[]) =>
      sql.all<{ summary: string }>(
        `SELECT coalesce(c.summary, b.summary) AS summary FROM (${page}) p
         LEFT JOIN conversations c ON c.id = p.id LEFT JOIN bundles b ON b.id = p.id
         ORDER BY p.date DESC, p.id DESC`,
        ...bound,
      );
    if (!row) {
      const page = `${all} ORDER BY date DESC, id DESC LIMIT ? OFFSET ?`;
      return { rows: summaries(page, ...each, size, at), at };
    }
    const above = row.place - at;
    const page = `
      SELECT * FROM (
        SELECT id, date FROM (${all}) WHERE (date, id) > (?, ?) ORDER BY date, id LIMIT ?
      ) UNION ALL SELECT * FROM (
        SELECT id, date FROM (${all}) WHERE (date, id) <= (?, ?) ORDER BY date DESC, id DESC LIMIT ?
      )`;
    const from = [row.date, row.id];
    return { rows: summaries(page, ...each, ...from, above, ...each, ...from, size - above), at };
  }

  /**
   * A row of a list that merges `parts`, each a query of `id` and `date`, newest first and ties by
   * id, with its place, which is how many rows come before it, or nothing when none of them holds
   * it.
   */
  function rowAmong(
    parts: readonly Part[],
    id: string,
  ): { id: string; date: string; place: number } | undefined {
    const [held] = parts.flatMap((part) =>
      sql.all<{ date: string }>(`SELECT date FROM (${part.sql}) WHERE id = ?`, ...part.params, id),
    );
    if (!held) return undefined;
    const place = parts.reduce(
      (above, part) =>
        above +
        sql.all<{ above: number }>(
          `SELECT COUNT(*) AS above FROM (${part.sql}) WHERE (date, id) > (?, ?)`,
          ...part.params,
          held.date,
          id,
        )[0]!.above,
      0,
    );
    return { id, date: held.date, place };
  }

  return {
    /**
     * One page of a view, newest first: `size` rows from its place `at`, with 0 the newest, or the
     * page holding the row `at` names, and how many the view holds. An Inbox view lists the
     * conversations no bundle holds and the bundles beside them, merging the two as far as the
     * page's place by id alone, and reads only the page's own rows. A view of unread mail lists its
     * unread rows, and the read one `keep` names, if it holds it.
     */
    page(
      view: Exclude<View, { in: 'search' } | { in: 'outbox' }>,
      asked: PageAt = 0,
      size = PAGE_SIZE,
      keep?: ConversationId,
    ): Page {
      if (view.in === 'folder' || view.in === 'inbox') {
        const unread = view.unread ? { keep } : undefined;
        const bundles = { select: `SELECT id, date FROM bundles`, key: 'id' };
        if (view.in === 'folder') {
          const { account, path } = view.folder;
          const where = ['account = ?', 'path = ?'];
          return listed(
            [
              part(
                {
                  select: `SELECT conversation AS id, date FROM placements`,
                  key: 'conversation',
                  where: [...where, 'bundle IS NULL'],
                  params: [account, path],
                },
                unread,
              ),
              part({ ...bundles, where, params: [account, path] }, unread),
            ],
            asked,
            size,
          );
        }
        return listed(
          [
            part(
              {
                select: `SELECT id, date FROM conversations`,
                key: 'id',
                where: ['inbox = 1', 'bundle IS NULL'],
                params: [],
              },
              unread,
            ),
            part({ ...bundles, where: [], params: [] }, unread),
          ],
          asked,
          size,
        );
      }
      const listedIn = `SELECT id, date FROM conversations WHERE ${view.in} = 1`;
      return listed([{ sql: listedIn, params: [] }], asked, size);
    },

    /**
     * One page of a bundle's conversations, newest first, with the bundle's row, or nothing of a
     * bundle that holds none.
     */
    bundle(id: BundleId, asked: PageAt = 0, size = PAGE_SIZE): BundlePage {
      const threads = `SELECT id, date FROM conversations WHERE bundle = ?`;
      const { rows, at } = pageOf([{ sql: threads, params: [id] }], asked, size);
      const [held] = sql.all<{ summary: string }>(`SELECT summary FROM bundles WHERE id = ?`, id);
      if (!held) return { items: [], at, total: 0 };
      const bundle = JSON.parse(held.summary) as BundleSummary;
      return { bundle, items: rows.map(summaryIn), at, total: bundle.threads };
    },

    /**
     * One page of the conversations with a message whose senders, recipients, subject or preview
     * hold every word of `text`, each word as typed so far, across every account: `size` of them
     * from place `at`, or around the conversation it names, and how many are listed. They come
     * newest first by the newest message that matches, and each row shows that message. A search
     * lists at most its newest `most`, so it reads matches newest first and stops there, and a
     * first letter costs no more than a word.
     */
    search(
      text: string,
      asked: PageAt = 0,
      size = PAGE_SIZE,
      most = MATCHES_LISTED,
    ): Page<ConversationSummary> {
      const match = matchOf(text);
      if (!match) return { items: [], at: startOf(asked, size, () => undefined), total: 0 };
      const newest = new Map<string, number>();
      for (const { rowid, conversation } of sql.each<{ rowid: number; conversation: string }>(
        `SELECT m.rowid, m.conversation FROM search JOIN messages m ON m.rowid = search.rowid
         WHERE search MATCH ? ORDER BY search.rowid DESC`,
        match,
      )) {
        if (newest.has(conversation)) continue;
        newest.set(conversation, rowid);
        if (newest.size === most) break;
      }
      const listed = [...newest];
      const at = startOf(asked, size, (id) =>
        listed.findIndex(([conversation]) => conversation === id),
      );
      const items = listed.slice(at, at + size).flatMap(([conversation, rowid]) => {
        const [row] = sql.all<{ summary: string }>(
          `SELECT summary FROM conversations WHERE id = ?`,
          conversation,
        );
        const [message] = sql.all<Row>(`SELECT ${COLUMNS} FROM messages WHERE rowid = ?`, rowid);
        return row && message ? [matchedRow(summaryIn(row), messageIn(message))] : [];
      });
      return { items, at, total: newest.size };
    },
  };
}

/** A search's row: its conversation, shown by the newest message in it that matched. */
export function matchedRow(
  conversation: ConversationSummary,
  { subject, preview, date }: Pick<Message, 'subject' | 'preview' | 'date'>,
): ConversationSummary {
  return { ...conversation, subject, preview, date };
}

/** One page of rows already in order, newest first, as the index pages its own. */
export function pageAfter(
  rows: readonly ConversationSummary[],
  asked: PageAt = 0,
  size = PAGE_SIZE,
): Page<ConversationSummary> {
  const at = startOf(asked, size, (id) => rows.findIndex((row) => row.id === id));
  return { items: rows.slice(at, at + size), at, total: rows.length };
}

/**
 * Where a page starts: at the place asked for, or at the page of `size` holding the row asked
 * around, from the place `placeOfRow` finds for it, or at the top of a list that doesn't hold it,
 * for which it finds nothing or −1, as `findIndex` does.
 */
function startOf(
  asked: PageAt,
  size: number,
  placeOfRow: (id: string) => number | undefined,
): number {
  if (typeof asked === 'number') return asked;
  const place = placeOfRow(asked.around) ?? -1;
  return place < 0 ? 0 : place - (place % size);
}

/** A query of a list's rows of one kind, and the values it takes. */
type Part = { sql: string; params: readonly SqlValue[] };

/**
 * What a list's rows of one kind are read from: a `SELECT` of `id` and `date`, the column that
 * names a row, the conditions a row meets, and the values they take.
 */
type PartOf = {
  select: string;
  key: string;
  where: readonly string[];
  params: readonly SqlValue[];
};
