import type {
  BundleId,
  BundleSummary,
  Flags,
  Folder,
  FolderRef,
  FolderRole,
  Message,
  MessageRef,
  View,
} from '../../mail/core/index.ts';
import type { Action } from './triage.ts';

/**
 * Carrying out triage: what archiving, deleting, moving, flagging and marking read ask the Mailroom
 * to do to conversations' messages. A move takes a conversation's messages out of the folders its
 * view shows. A flag or a read mark changes only the messages that aren't already as asked, so Undo
 * puts back exactly what changed.
 */

/** What the Mailroom is asked to do, in the terms of its commands. */
export type Command =
  | { move: MessageRef[]; to: FolderRef | FolderRole }
  | { setFlags: MessageRef[]; change: Partial<Flags> };

/**
 * What the Mailroom is asked to do to a bundle's conversations, as far as its row showed them: the
 * messages they held by its date. The Mailroom finds them, and says which it changed or moved.
 */
export type BundleCommand =
  | { move: BundleScope; to: FolderRef | FolderRole }
  | { setFlags: BundleScope; change: Partial<Flags> };

type BundleScope = { bundle: BundleId; through: string };

/** Where a moved message went, as the Mailroom reports it. */
export type Moved = { from: MessageRef; to: MessageRef };

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

/**
 * The command that carries out an action on a bundle, or nothing when it can't: a move to another
 * account, or to the Inbox its conversations lie in. A flag and an unread mark reach each
 * conversation's newest message, and the rest reach every message.
 */
export function bundleCommandFor(
  action: Action,
  bundle: BundleSummary,
  folders: readonly Folder[],
): BundleCommand | undefined {
  const scope = { bundle: bundle.id, through: bundle.date };
  switch (action.do) {
    case 'archive':
    case 'delete':
      return { move: scope, to: destination(action) };
    case 'move':
      return action.to.account === bundle.account &&
        roleOf(folders, action.to.account, action.to.path) !== 'inbox'
        ? { move: scope, to: action.to }
        : undefined;
    case 'flag':
      return { setFlags: scope, change: { flagged: true } };
    case 'unflag':
      return { setFlags: scope, change: { flagged: false } };
    case 'read':
      return { setFlags: scope, change: { seen: true } };
    case 'unread':
      return { setFlags: scope, change: { seen: false } };
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

/**
 * An open conversation's messages once a flag or read change reached them. A message already as
 * asked stays as it was.
 */
export function changeMessages(messages: readonly Message[], command: Command): Message[] {
  if (!('setFlags' in command)) return [...messages];
  const changed = new Set(command.setFlags.map(keyOf));
  const changes = Object.entries(command.change) as [keyof Flags, boolean][];
  return messages.map((message) =>
    changed.has(keyOf(message)) && changes.some(([flag, value]) => message.flags[flag] !== value)
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
