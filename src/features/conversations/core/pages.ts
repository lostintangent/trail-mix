import { bundlePartsOf, type ConversationId } from '../../mail/core/index.ts';

/**
 * A list a page at a time. The browser keeps each page of a view's list it has fetched by the place
 * the page starts at, and lays the pages out in a list as long as the whole, with the places of
 * pages it hasn't fetched left empty. So the list is its true length from its first page on, and
 * any stretch of it can be fetched alone, as when the list is dragged to its middle.
 */

/** A list whose places are each a row, or empty while the page holding it hasn't arrived. */
export type Listed<Row> = readonly (Row | undefined)[];

/** A page of a list as fetched: its rows from place `at`, how long the list was, and when. */
export type Fetched<Row> = { items: readonly Row[]; at: number; total: number; fetchedAt: number };

/**
 * A list as its fetched pages show it, or nothing until one has arrived. Pages fetched at different
 * times can disagree, as when mail that arrived between them moved every row down a place. Then
 * the fresher page's word stands: the list is as long as the freshest page says, a place holds what
 * the freshest page covering it holds, and a conversation shows once, where the freshest page that
 * holds it puts it.
 */
export function listOf<Row extends { id: ConversationId }>(
  pages: readonly Fetched<Row>[],
): Listed<Row> | undefined {
  const freshestFirst = pages.toSorted((a, b) => b.fetchedAt - a.fetchedAt);
  const total = freshestFirst[0]?.total;
  if (total === undefined) return undefined;
  const rows = Array.from<Row | undefined>({ length: total });
  const placed = new Set<ConversationId>();
  for (const { items, at } of freshestFirst) {
    for (const [offset, row] of items.entries()) {
      const place = at + offset;
      if (place >= total || rows[place] || placed.has(row.id)) continue;
      rows[place] = row;
      placed.add(row.id);
    }
  }
  return rows;
}

/**
 * The places the pages start at that cover some stretches of a list, each from its first row to its
 * last, in a list of `total` rows. The first page covers a list with no rows, so an empty list is
 * still asked about.
 */
export function pagesCovering(
  stretches: readonly (readonly [first: number, last: number])[],
  total: number,
  size: number,
): number[] {
  const pages = new Set<number>();
  for (const [first, last] of stretches) {
    const from = Math.floor(Math.max(0, first) / size);
    const to = Math.floor(Math.min(last, total - 1) / size);
    for (let page = from; page <= to; page++) pages.add(page * size);
  }
  if (pages.size === 0) pages.add(0);
  return [...pages].sort((a, b) => a - b);
}

/**
 * Where each conversation a list has fetched lies in it, so a row is found by its id without
 * reading the whole list, which may be tens of thousands of places long.
 */
export function placesOf<Row extends { id: ConversationId }>(
  rows: Listed<Row>,
): ReadonlyMap<ConversationId, number> {
  const places = new Map<ConversationId, number>();
  for (let place = 0; place < rows.length; place++) {
    const row = rows[place];
    if (row) places.set(row.id, place);
  }
  return places;
}

/**
 * The conversations the member may open next, which the reader prepares ahead: those just below and
 * above the selected one, or the first ones while nothing is selected.
 */
export function neighbors<Row extends { id: ConversationId }>(
  conversations: Listed<Row> | undefined,
  places: ReadonlyMap<ConversationId, number>,
  selected: ConversationId | undefined,
): ConversationId[] {
  if (!conversations) return [];
  const at = selected === undefined ? undefined : places.get(selected);
  if (selected !== undefined && at === undefined) return [];
  const near =
    at === undefined ? conversations.slice(0, 2) : [conversations[at + 1], conversations[at - 1]];
  // A bundle is no conversation to prepare.
  return idsIn(near).filter((id) => bundlePartsOf(id) === undefined);
}

/** The ids of a list's fetched rows, in its order. */
export function idsIn<Row extends { id: ConversationId }>(rows: Listed<Row>): ConversationId[] {
  return rows.flatMap((row) => (row ? [row.id] : []));
}
