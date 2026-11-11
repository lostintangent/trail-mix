import type { ConversationId } from '../../mail/core/index.ts';

/** The conversations a member has picked out of a list, and the one a range extends from. */
export type Selection = { ids: readonly ConversationId[]; anchor?: ConversationId };

/** How a pick changes the selection: to that one alone, in or out of it, or out to it as a range. */
export type SelectBy = 'only' | 'toggle' | 'extend';

export const NOTHING_SELECTED: Selection = { ids: [] };

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
      return { ids: [id], anchor: id };
    case 'toggle': {
      const ids = selection.ids.includes(id)
        ? selection.ids.filter((each) => each !== id)
        : order.filter((each) => each === id || selection.ids.includes(each));
      return { ids, anchor: id };
    }
    case 'extend': {
      const from = order.indexOf(selection.anchor ?? id);
      const to = order.indexOf(id);
      if (from < 0 || to < 0) return { ids: [id], anchor: id };
      return {
        ids: order.slice(Math.min(from, to), Math.max(from, to) + 1),
        anchor: selection.anchor ?? id,
      };
    }
  }
}
