import { sameFlags, type Flags, type FolderRole } from '../../mail/core/index.ts';
import {
  SEEDED_FOLDERS,
  seededFolders,
  seededMessage,
  seededSize,
  seededTime,
  type Content,
  type DemoKind,
} from './stories.ts';

/**
 * The demo's mail server for one account, as an immutable value: the seeded mailbox, plus what has
 * changed since. A change is never written into the seed. Instead the value records which seeded
 * messages are no longer where they were seeded, and holds every message that is not, so the
 * value stays small however large the mailbox, and it is what the Mailroom stores.
 *
 * It behaves as an IMAP server does: UIDs only grow within a folder, a move gives a message a new
 * UID where it lands, every change raises a MODSEQ, and UIDVALIDITY changes when UIDs start over.
 * Every operation is a pure step to the next mailbox, and repeating one changes nothing.
 */
export type DemoMailbox = {
  kind: DemoKind;
  /** How many messages were seeded. */
  size: number;
  /** When the mailbox was made. Seeded mail is dated back from it. */
  createdAt: string;
  /** The last MODSEQ handed out. Seeded messages all have 1. */
  modSeq: number;
  folders: DemoFolder[];
  /** Seeded UIDs that are no longer where they were seeded: changed, moved or expunged. */
  moved: number[];
  /** Every message that is not where the seed put it. */
  stored: Stored[];
  /**
   * What the server has turned away once, so the next try goes: a message by its Message-ID, a
   * folder's delete as `DELETE` and its path, or a one-click unsubscribe as `UNSUBSCRIBE` and its
   * address, which the demo's list servers turn away.
   */
  refused?: string[];
};

type DemoFolder = {
  path: string;
  role?: FolderRole;
  uidValidity: number;
  uidNext: number;
  /** The MODSEQ of the folder's latest change. */
  modSeq: number;
  /** The seeded folder whose messages this one holds. It stays the same through a rename. */
  seeded?: string;
};

/** A message as the server holds it. What it says is read only when asked. */
type Held = {
  uid: number;
  modSeq: number;
  flags: Flags;
  date: string;
  content(): Content;
  text(): string;
  raw(): string;
};

/** A message from outside the seed: delivered, or saved as a draft. */
export type Written = { raw: string; content: Content; text: string };

type Stored = {
  path: string;
  uid: number;
  modSeq: number;
  flags: Flags;
  source: { seeded: number } | Written;
};

/** A new mailbox whose Inbox holds `inbox` seeded messages. */
export function demoMailbox(kind: DemoKind, inbox: number, createdAt: string): DemoMailbox {
  const size = seededSize(kind, inbox);
  return {
    kind,
    size,
    createdAt,
    modSeq: 1,
    folders: SEEDED_FOLDERS[kind].map(({ path, role }) => ({
      path,
      ...(role ? { role } : {}),
      uidValidity: 1,
      uidNext: size + 1,
      modSeq: 1,
      seeded: path,
    })),
    moved: [],
    stored: [],
  };
}

export function folderOf(mailbox: DemoMailbox, path: string): DemoFolder | undefined {
  return mailbox.folders.find((folder) => folder.path === path);
}

export function folderWithRole(mailbox: DemoMailbox, role: FolderRole): DemoFolder | undefined {
  return mailbox.folders.find((folder) => folder.role === role);
}

/** The UIDs of a folder's messages, ascending. */
export function uidsIn(mailbox: DemoMailbox, path: string): number[] {
  const folder = folderOf(mailbox, path);
  if (!folder) return [];
  const moved = new Set(mailbox.moved);
  const seeded = folder.seeded ? (seededIn(mailbox, folder.seeded)?.uids ?? []) : [];
  const stored = mailbox.stored.filter((entry) => entry.path === path).map((entry) => entry.uid);
  return [...seeded.filter((uid) => !moved.has(uid)), ...stored].sort((a, b) => a - b);
}

/** The UIDs of a folder's messages that arrived at or after `since`, as `UID SEARCH SINCE` finds. */
export function uidsSince(mailbox: DemoMailbox, path: string, since: string): number[] {
  const from = Date.parse(since);
  const stored = new Map(
    mailbox.stored.filter((entry) => entry.path === path).map((entry) => [entry.uid, entry]),
  );
  return uidsIn(mailbox, path).filter((uid) => {
    const entry = stored.get(uid);
    const time = entry
      ? Date.parse(held(mailbox, entry).date)
      : seededTime(mailbox.size, mailbox.createdAt, uid);
    return time >= from;
  });
}

/** The flags of a folder's messages that changed after MODSEQ `since`, as `CHANGEDSINCE` finds. */
export function flagsChangedSince(
  mailbox: DemoMailbox,
  path: string,
  since: number,
): Map<number, Flags> {
  return new Map(
    mailbox.stored
      .filter((entry) => entry.path === path && entry.modSeq > since)
      .map((entry) => [entry.uid, entry.flags]),
  );
}

export function messageAt(mailbox: DemoMailbox, path: string, uid: number): Held | undefined {
  const entry = mailbox.stored.find((stored) => stored.path === path && stored.uid === uid);
  if (entry) return held(mailbox, entry);
  const folder = folderOf(mailbox, path);
  if (!folder?.seeded || mailbox.moved.includes(uid)) return undefined;
  const seeded = seededMessage(mailbox.kind, mailbox.size, mailbox.createdAt, uid);
  if (seeded?.folder !== folder.seeded) return undefined;
  return { uid, modSeq: 1, ...seeded };
}

/** How many messages a folder holds, and how many of them are unread. */
export function countsOf(mailbox: DemoMailbox, path: string): { total: number; unread: number } {
  const folder = folderOf(mailbox, path);
  const seeded = folder?.seeded ? seededIn(mailbox, folder.seeded) : undefined;
  let total = seeded?.uids.length ?? 0;
  let unread = seeded?.unread ?? 0;
  for (const uid of mailbox.moved) {
    const message = seededMessage(mailbox.kind, mailbox.size, mailbox.createdAt, uid);
    if (folder?.seeded && message?.folder === folder.seeded) {
      total--;
      if (!message.flags.seen) unread--;
    }
  }
  for (const entry of mailbox.stored) {
    if (entry.path !== path) continue;
    total++;
    if (!entry.flags.seen) unread++;
  }
  return { total, unread };
}

// Changes

export function setFlags(
  mailbox: DemoMailbox,
  path: string,
  uids: readonly number[],
  change: Partial<Flags>,
): DemoMailbox {
  return uids.reduce((current, uid) => {
    const message = messageAt(current, path, uid);
    const flags = message && { ...message.flags, ...change };
    if (!message || !flags || sameFlags(message.flags, flags)) return current;
    const [next, modSeq] = nextModSeq(current, path);
    return rewrite(next, path, uid, (entry) => ({ ...entry, modSeq, flags }));
  }, mailbox);
}

/**
 * Moves messages that are still in `path` to `to`, where each gets the next UID. Says each moved
 * message's UID before and after, as UIDPLUS does.
 */
export function move(
  mailbox: DemoMailbox,
  path: string,
  uids: readonly number[],
  to: string,
): [DemoMailbox, [from: number, to: number][]] {
  if (!folderOf(mailbox, to)) throw new Error(`There is no folder "${to}" to file it in.`);
  if (to === path) return [mailbox, []];
  const moved: [number, number][] = [];
  const next = uids.reduce((current, uid) => {
    const entry = storedAt(current, path, uid);
    if (!entry) return current;
    const [copied, landed] = add(current, to, entry.source, entry.flags);
    moved.push([uid, landed]);
    return expunge(copied, path, [uid]);
  }, mailbox);
  return [next, moved];
}

export function expunge(mailbox: DemoMailbox, path: string, uids: readonly number[]): DemoMailbox {
  return uids.reduce((current, uid) => {
    if (!messageAt(current, path, uid)) return current;
    return rewrite(nextModSeq(current, path)[0], path, uid, () => undefined);
  }, mailbox);
}

/** Files a message from outside the seed in a folder, and says the UID it was given. */
export function append(
  mailbox: DemoMailbox,
  path: string,
  message: Written,
  flags: Flags,
): [DemoMailbox, number] {
  if (!folderOf(mailbox, path)) throw new Error(`There is no folder "${path}" to file it in.`);
  return add(mailbox, path, message, flags);
}

/** Numbers a folder's messages again under a new UIDVALIDITY, as a server that lost its state does. */
export function renumber(mailbox: DemoMailbox, path: string): DemoMailbox {
  return mapFolder(mailbox, path, (folder) => ({ ...folder, uidValidity: folder.uidValidity + 1 }));
}

export function createFolder(mailbox: DemoMailbox, path: string): DemoMailbox {
  if (folderOf(mailbox, path)) return mailbox;
  // A folder made again after it was deleted starts its UIDs over, so it needs a UIDVALIDITY of
  // its own. The MODSEQ counter never goes back, so it is one.
  const modSeq = mailbox.modSeq + 1;
  return {
    ...mailbox,
    modSeq,
    folders: [...mailbox.folders, { path, uidValidity: modSeq, uidNext: 1, modSeq }],
  };
}

/** Renames a folder and every folder inside it. Their messages keep their UIDs. */
export function renameFolder(mailbox: DemoMailbox, path: string, to: string): DemoMailbox {
  if (path === 'INBOX') throw new Error('The Inbox cannot be renamed.');
  if (!folderOf(mailbox, path)) return mailbox;
  if (folderOf(mailbox, to)) throw new Error(`There is already a folder "${to}".`);
  const renamed = (inner: string) =>
    inner === path ? to : inner.startsWith(`${path}/`) ? `${to}${inner.slice(path.length)}` : inner;
  return {
    ...mailbox,
    folders: mailbox.folders.map((folder) => ({ ...folder, path: renamed(folder.path) })),
    stored: mailbox.stored.map((entry) => ({ ...entry, path: renamed(entry.path) })),
  };
}

/** Deletes a folder, every folder inside it, and their messages. */
export function deleteFolder(mailbox: DemoMailbox, path: string): DemoMailbox {
  if (path === 'INBOX') throw new Error('The Inbox cannot be deleted.');
  if (!folderOf(mailbox, path)) return mailbox;
  const goes = (held: string) => held === path || held.startsWith(`${path}/`);
  return {
    ...mailbox,
    folders: mailbox.folders.filter((folder) => !goes(folder.path)),
    stored: mailbox.stored.filter((entry) => !goes(entry.path)),
  };
}

/**
 * The mailbox with nothing in it and only the folders it started with. Folders keep counting
 * their UIDs up, so nothing that was in them can be mistaken for what arrives next.
 */
export function emptied(mailbox: DemoMailbox): DemoMailbox {
  const fresh = demoMailbox(mailbox.kind, 0, mailbox.createdAt);
  const modSeq = mailbox.modSeq + 1;
  return {
    ...fresh,
    modSeq,
    folders: fresh.folders.map((folder) => {
      const before = folderOf(mailbox, folder.path);
      return {
        ...folder,
        modSeq,
        uidValidity: before?.uidValidity ?? modSeq,
        uidNext: Math.max(before?.uidNext ?? 1, 1),
      };
    }),
  };
}

// Mechanics

function seededIn(mailbox: DemoMailbox, seeded: string) {
  return seededFolders(mailbox.kind, mailbox.size).get(seeded);
}

function held(mailbox: DemoMailbox, entry: Stored): Held {
  const { source } = entry;
  if ('raw' in source) {
    return {
      uid: entry.uid,
      modSeq: entry.modSeq,
      flags: entry.flags,
      date: source.content.date,
      content: () => source.content,
      text: () => source.text,
      raw: () => source.raw,
    };
  }
  const seeded = seededMessage(mailbox.kind, mailbox.size, mailbox.createdAt, source.seeded)!;
  return { ...seeded, uid: entry.uid, modSeq: entry.modSeq, flags: entry.flags };
}

/** A folder's message as an entry that can be stored, whether the seed put it there or not. */
function storedAt(mailbox: DemoMailbox, path: string, uid: number): Stored | undefined {
  const message = messageAt(mailbox, path, uid);
  if (!message) return undefined;
  return (
    mailbox.stored.find((entry) => entry.path === path && entry.uid === uid) ?? {
      path,
      uid,
      modSeq: 1,
      flags: message.flags,
      source: { seeded: uid },
    }
  );
}

/**
 * Replaces or removes a folder's message. One the seed put there is marked as moved, so the seed
 * no longer shows it, and whatever replaces it is stored.
 */
function rewrite(
  mailbox: DemoMailbox,
  path: string,
  uid: number,
  change: (entry: Stored) => Stored | undefined,
): DemoMailbox {
  const entry = storedAt(mailbox, path, uid)!;
  const seeded = !mailbox.stored.includes(entry);
  const replacement = change(entry);
  return {
    ...mailbox,
    moved: seeded ? [...mailbox.moved, uid] : mailbox.moved,
    stored: [
      ...mailbox.stored.filter((stored) => stored !== entry),
      ...(replacement ? [replacement] : []),
    ],
  };
}

function add(
  mailbox: DemoMailbox,
  path: string,
  source: Stored['source'],
  flags: Flags,
): [DemoMailbox, number] {
  const uid = folderOf(mailbox, path)!.uidNext;
  const [next, modSeq] = nextModSeq(mailbox, path);
  return [
    {
      ...mapFolder(next, path, (folder) => ({ ...folder, uidNext: uid + 1 })),
      stored: [...next.stored, { path, uid, modSeq, flags, source }],
    },
    uid,
  ];
}

/** Hands out the next MODSEQ as the latest change of `path`. */
function nextModSeq(mailbox: DemoMailbox, path: string): [DemoMailbox, number] {
  const modSeq = mailbox.modSeq + 1;
  return [mapFolder({ ...mailbox, modSeq }, path, (folder) => ({ ...folder, modSeq })), modSeq];
}

function mapFolder(
  mailbox: DemoMailbox,
  path: string,
  change: (folder: DemoFolder) => DemoFolder,
): DemoMailbox {
  return {
    ...mailbox,
    folders: mailbox.folders.map((folder) => (folder.path === path ? change(folder) : folder)),
  };
}
