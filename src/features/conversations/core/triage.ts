import type {
  ConversationId,
  ConversationSummary,
  FolderRef,
  ListItem,
  View,
} from '../../mail/core/index.ts';
import type { Listed } from './pages.ts';

/**
 * Triage as a list shows it: archiving, deleting, moving, flagging and marking read change a
 * conversation's row, or take it away, in the frame they're asked for, ahead of the Mailroom's own
 * list. What the Mailroom is asked to do is `carrying.ts`'s.
 */

export type Action =
  | { do: 'archive' }
  | { do: 'delete' }
  | { do: 'move'; to: FolderRef }
  | { do: 'flag' }
  | { do: 'unflag' }
  | { do: 'read' }
  | { do: 'unread' };

/** How a conversation's row changes in the list it was triaged from. */
type RowChange = 'gone' | Partial<Pick<ConversationSummary, 'flagged' | 'unread'>>;

/** How a triaged conversation's row changes in the view it was triaged from, if it does. */
export function rowChange(action: Action, view: View): RowChange | undefined {
  switch (action.do) {
    case 'archive':
    case 'delete':
    case 'move':
      // Flagged and a search still hold a conversation wherever its messages went.
      return view.in === 'flagged' || view.in === 'search' ? undefined : 'gone';
    case 'flag':
      return { flagged: true };
    case 'unflag':
      return view.in === 'flagged' ? 'gone' : { flagged: false };
    case 'read':
      return { unread: 0 };
    case 'unread':
      return { unread: 1 };
  }
}

/**
 * A list's rows after some of its conversations changed. Places not yet fetched stay as they are. A
 * bundle marked read or unread marks every thread its chips stand for.
 */
export function changeRows<Row extends { id: ConversationId }>(
  rows: Listed<Row>,
  ids: ReadonlySet<ConversationId>,
  change: RowChange,
): (Row | undefined)[] {
  if (change === 'gone') return rows.filter((row) => !row || !ids.has(row.id));
  const { unread } = change;
  const marked = (row: Row): Row =>
    unread !== undefined && 'chips' in row && Array.isArray(row.chips)
      ? { ...row, chips: row.chips.map((chip: object) => ({ ...chip, unread: unread > 0 })) }
      : row;
  return rows.map((row) => (row && ids.has(row.id) ? marked({ ...row, ...change }) : row));
}

/**
 * A list's rows with some conversations' earlier rows put back, as an Undo or a refusal shows them:
 * a row still listed takes its earlier self, and a row that left returns where the Mailroom lists
 * it, newest first, and by id, highest first, among rows of one date. Among places not yet fetched,
 * it returns just above the first row listed after it.
 */
export function putBack<Row extends { id: ConversationId; date: string }>(
  rows: Listed<Row>,
  earlier: readonly Row[],
): (Row | undefined)[] {
  const byId = new Map(earlier.map((row) => [row.id, row]));
  const shown = rows.map((row) => (row && byId.get(row.id)) ?? row);
  const listed = new Set(rows.flatMap((row) => (row ? [row.id] : [])));
  for (const returning of earlier.filter(({ id }) => !listed.has(id)).toSorted(listOrder)) {
    const before = shown.findIndex((row) => row !== undefined && listOrder(returning, row) < 0);
    shown.splice(before < 0 ? shown.findLastIndex(Boolean) + 1 : before, 0, returning);
  }
  return shown;
}

/** The order the Mailroom lists rows in: newest first, and by id, highest first, among one date. */
const listOrder = (
  a: { id: ConversationId; date: string },
  b: { id: ConversationId; date: string },
) => (a.date !== b.date ? (a.date < b.date ? 1 : -1) : a.id < b.id ? 1 : a.id > b.id ? -1 : 0);

/**
 * What a list shows ahead of the Mailroom's own list: some rows changed or gone, or earlier rows put
 * back by an Undo. A browser lays it over each snapshot until a snapshot already shows it, since a
 * snapshot fetched before the Mailroom folded the change would otherwise undo it on screen.
 */
export type Overlay<Row extends ListRow = ListItem> =
  { ids: ReadonlySet<ConversationId>; change: RowChange } | { returning: readonly Row[] };

type ListRow = { id: ConversationId; date: string } & Pick<
  ConversationSummary,
  'flagged' | 'unread'
>;

/** A list's rows with overlays laid over them, in the order they were made. */
export function overlaid<Row extends ListRow>(
  rows: Listed<Row>,
  overlays: readonly Overlay<Row>[],
): Listed<Row> {
  return overlays.reduce<Listed<Row>>(
    (shown, overlay) =>
      'returning' in overlay
        ? putBack(shown, overlay.returning)
        : changeRows(shown, overlay.ids, overlay.change),
    rows,
  );
}

/** Whether a list's rows already show what an overlay would, so it has nothing left to do. */
export function isShown<Row extends ListRow>(rows: Listed<Row>, overlay: Overlay<Row>): boolean {
  if ('returning' in overlay) {
    const listed = new Map(rows.flatMap((row) => (row ? [[row.id, row] as const] : [])));
    return overlay.returning.every((earlier) => {
      const row = listed.get(earlier.id);
      return row?.unread === earlier.unread && row.flagged === earlier.flagged;
    });
  }
  const { ids, change } = overlay;
  const triaged = rows.filter((row): row is Row => row !== undefined && ids.has(row.id));
  if (change === 'gone') return triaged.length === 0;
  return triaged.every((row) =>
    (Object.keys(change) as (keyof typeof change)[]).every((field) => row[field] === change[field]),
  );
}
