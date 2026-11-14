import type { ConversationId } from '../../mail/core/index.ts';

/**
 * The conversations a member has picked out of a list, the one a range extends from, and the active
 * one: the one keys move from and the list names, which is the last picked, or a range's moving end.
 */
export type Selection = {
  ids: readonly ConversationId[];
  anchor?: ConversationId;
  active?: ConversationId;
};

/** How a pick changes the selection: to that one alone, in or out of it, or out to it as a range. */
export type SelectBy = 'only' | 'toggle' | 'extend';

export const NOTHING_SELECTED: Selection = { ids: [] };

/** A selection of `id` alone, which both ends of a range start from, or of nothing without one. */
export const selectOnly = (id: ConversationId | undefined): Selection =>
  id === undefined ? NOTHING_SELECTED : { ids: [id], anchor: id, active: id };

/** Whether two selections pick the same conversations, in the same order. */
export const isSameSelection = (a: Selection, b: Selection) =>
  a.ids.length === b.ids.length && a.ids.every((id, at) => id === b.ids[at]);

/** The selection after a pick in a list whose conversations run in `order`. */
export function select(
  selection: Selection,
  id: ConversationId,
  by: SelectBy,
  order: readonly ConversationId[],
): Selection {
  switch (by) {
    case 'only':
      return selectOnly(id);
    case 'toggle': {
      const ids = selection.ids.includes(id)
        ? selection.ids.filter((each) => each !== id)
        : order.filter((each) => each === id || selection.ids.includes(each));
      return { ids, anchor: id, active: id };
    }
    case 'extend': {
      const anchor = selection.anchor ?? id;
      const from = order.indexOf(anchor);
      const to = order.indexOf(id);
      if (from < 0 || to < 0) return selectOnly(id);
      return { ids: order.slice(Math.min(from, to), Math.max(from, to) + 1), anchor, active: id };
    }
  }
}

/**
 * A row leaving the list, and where it was, until the selection has moved on from it. Meanwhile it
 * stays picked, and places count from where it was.
 */
export type Vacating<Row> = { row: Row; at: number };

/**
 * Where a conversation sits in a list, and where the row after it is: while it leaves, where it was,
 * so the row that took its place is the one after it. One neither listed nor leaving sits at -1.
 */
export function placeAmong(
  places: ReadonlyMap<ConversationId, number>,
  vacating: Vacating<{ id: ConversationId }> | undefined,
  id: ConversationId | undefined,
): { at: number; after: number } {
  const at = id === undefined ? -1 : (places.get(id) ?? -1);
  return at < 0 && vacating !== undefined && vacating.row.id === id
    ? { at: vacating.at, after: vacating.at }
    : { at, after: at + 1 };
}

/**
 * The rows a selection picks, in the list's order, whatever order they were picked in. One leaving
 * the list stays among them, last, until the selection moves on from it.
 */
export function pickedIn<Row extends { id: ConversationId }>(
  rows: readonly (Row | undefined)[] | undefined,
  places: ReadonlyMap<ConversationId, number>,
  ids: readonly ConversationId[],
  vacating: Vacating<Row> | undefined,
): Row[] {
  const picked = ids
    .flatMap((id) => rows?.[places.get(id) ?? -1] ?? [])
    .toSorted((a, b) => (places.get(a.id) ?? 0) - (places.get(b.id) ?? 0));
  return vacating && ids.includes(vacating.row.id) && !picked.includes(vacating.row)
    ? [...picked, vacating.row]
    : picked;
}
