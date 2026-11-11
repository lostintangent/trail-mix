import type {
  ConversationId,
  ConversationSummary,
  Flags,
  Folder,
  FolderRef,
  FolderRole,
  Message,
  MessageRef,
  View,
} from '../../mail/core/index.ts';
import type { Listed } from './pages.ts';

/**
 * Triage: what archiving, deleting, moving, flagging and marking read do to conversations. A move
 * takes a conversation's messages out of the folders its view shows. A flag or a read mark changes
 * only the messages that aren't already as asked, so Undo puts back exactly what changed.
 */

export type Action =
  | { do: 'archive' }
  | { do: 'delete' }
  | { do: 'move'; to: FolderRef }
  | { do: 'flag' }
  | { do: 'unflag' }
  | { do: 'read' }
  | { do: 'unread' };

/** What the Mailroom is asked to do, in the terms of its commands. */
export type Command =
  | { move: MessageRef[]; to: FolderRef | FolderRole }
  | { setFlags: MessageRef[]; change: Partial<Flags> };

/** Where a moved message went, as the Mailroom reports it. */
export type Moved = { from: MessageRef; to: MessageRef };

/** How a conversation's row changes in the list it was triaged from. */
export type RowChange = 'gone' | Partial<Pick<ConversationSummary, 'flagged' | 'unread'>>;

/**
 * The command that carries out an action on some conversations, or nothing when no message would
 * change. Each conversation is given as its messages, as the reader gets them. A move to a folder
 * takes only the messages of that folder's account, since mail can't move between accounts.
 */
export function commandFor(
  action: Action,
  view: View,
  conversations: readonly (readonly Message[])[],
  folders: readonly Folder[],
): Command | undefined {
  const all = conversations.flat();
  switch (action.do) {
    case 'archive':
    case 'delete':
    case 'move': {
      const shown = all.filter((message) => isShownIn(view, message, folders));
      const movable =
        action.do === 'move'
          ? shown.filter(
              ({ account, path }) => account === action.to.account && path !== action.to.path,
            )
          : shown.filter(
              ({ account, path }) => roleOf(folders, account, path) !== destination(action),
            );
      const to = action.do === 'move' ? action.to : destination(action);
      return movable.length > 0 ? { move: movable.map(refOf), to } : undefined;
    }
    case 'flag':
      return flagsFor(conversations.map(newest), { flagged: true });
    case 'unflag':
      return flagsFor(all, { flagged: false });
    case 'read':
      return flagsFor(all, { seen: true });
    case 'unread':
      return flagsFor(conversations.map(newest), { seen: false });
  }
}

/** What undoes a command: each moved message back to the folder it left, or each flag back. */
export function undoOf(command: Command, moved: readonly Moved[] = []): Command[] {
  if ('setFlags' in command) {
    const change = Object.fromEntries(
      Object.entries(command.change).map(([flag, value]) => [flag, !value]),
    );
    return [{ setFlags: command.setFlags, change }];
  }
  const back = Map.groupBy(moved, ({ from }) => `${from.account}\n${from.path}`);
  return [...back.values()].map((pairs) => ({
    move: pairs.map(({ to }) => to),
    to: { account: pairs[0]!.from.account, path: pairs[0]!.from.path },
  }));
}

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

/** A list's rows after some of its conversations changed. Places not yet fetched stay as they are. */
export function changeRows<Row extends { id: ConversationId }>(
  rows: Listed<Row>,
  ids: ReadonlySet<ConversationId>,
  change: RowChange,
): (Row | undefined)[] {
  if (change === 'gone') return rows.filter((row) => !row || !ids.has(row.id));
  return rows.map((row) => (row && ids.has(row.id) ? { ...row, ...change } : row));
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
export type Overlay<Row extends ListRow = ConversationSummary> =
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

/** An open conversation's messages once a flag or read change reached them. */
export function changeMessages(messages: readonly Message[], command: Command): Message[] {
  if (!('setFlags' in command)) return [...messages];
  const changed = new Set(command.setFlags.map(keyOf));
  return messages.map((message) =>
    changed.has(keyOf(message))
      ? { ...message, flags: { ...message.flags, ...command.change } }
      : message,
  );
}

/**
 * A conversation's messages once some of them moved, or nothing when none of them did. A move gives
 * a message a new ref and retires the old one, so each moved message is known by the ref it has
 * now, in the folder it went to.
 */
export function followMoves(
  messages: readonly Message[],
  moved: readonly Moved[],
): Message[] | undefined {
  const now = new Map(moved.map(({ from, to }) => [keyOf(from), to]));
  if (!messages.some((message) => now.has(keyOf(message)))) return undefined;
  return messages.map((message) => {
    const to = now.get(keyOf(message));
    return to ? { ...message, ...refOf(to) } : message;
  });
}

/**
 * Whether a view shows a message, so a move takes it out. A folder shows its own messages, Drafts
 * its drafts, and the other unified views the Inbox's. A search finds mail wherever it is, so it
 * shows every folder but Sent and Drafts, which hold what the member wrote.
 */
function isShownIn(view: View, message: Message, folders: readonly Folder[]): boolean {
  if (view.in === 'folder') {
    return message.account === view.folder.account && message.path === view.folder.path;
  }
  const role = roleOf(folders, message.account, message.path);
  switch (view.in) {
    case 'drafts':
      return role === 'drafts';
    case 'search':
      return role !== 'sent' && role !== 'drafts';
    default:
      return role === 'inbox';
  }
}

const destination = (action: { do: 'archive' | 'delete' }): FolderRole =>
  action.do === 'archive' ? 'archive' : 'trash';

const roleOf = (folders: readonly Folder[], account: string, path: string) =>
  folders.find((folder) => folder.account === account && folder.path === path)?.role;

/** The messages whose flag isn't already as asked, so Undo changes back exactly those. */
function flagsFor(
  messages: readonly (Message | undefined)[],
  change: { flagged: boolean } | { seen: boolean },
): Command | undefined {
  const [flag, value] = Object.entries(change)[0] as [keyof Flags, boolean];
  const refs = messages
    .filter((message): message is Message => message !== undefined && message.flags[flag] !== value)
    .map(refOf);
  return refs.length > 0 ? { setFlags: refs, change } : undefined;
}

const newest = (messages: readonly Message[]) =>
  messages.reduce<Message | undefined>(
    (latest, message) => (!latest || message.date > latest.date ? message : latest),
    undefined,
  );

const refOf = ({ account, path, uidValidity, uid }: MessageRef): MessageRef => ({
  account,
  path,
  uidValidity,
  uid,
});

const keyOf = ({ account, path, uidValidity, uid }: MessageRef) =>
  `${account}\n${path}\n${uidValidity}\n${uid}`;
