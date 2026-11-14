import {
  conversationIdOf,
  gatheringOf,
  linkConversations,
  linkIdsOf,
  partsOf,
  rootOf,
} from './conversations.ts';
import type {
  AccountId,
  ConversationId,
  Envelope,
  Flags,
  FolderRef,
  FolderRole,
  Message,
  MessageRef,
} from './model.ts';

/**
 * The index fold. A provider reports what changed on the mail server as sync events, and the
 * envelope index is the fold of those events: nothing else writes to it. The fold reads the index
 * through a few synchronous lookups and returns the rows to write, so the Mailroom can keep the
 * index in SQLite and apply each change in the same transaction as the reads it came from.
 *
 * Every event is safe to repeat. Folding one again changes nothing, and which messages share a
 * conversation never depends on the order their events arrived in.
 */

export type SyncEvent =
  /** New, newly inside the sync window, or read again. */
  | { type: 'message'; envelope: Envelope }
  | { type: 'flags'; ref: MessageRef; flags: Flags }
  /** Expunged, moved to another folder, or aged out of the sync window. */
  | { type: 'gone'; ref: MessageRef }
  /** UIDVALIDITY changed, or the sync starts over, so the folder's messages are forgotten. */
  | { type: 'reset'; folder: FolderRef };

/** What the fold reads. The Mailroom answers from SQLite, and `memoryIndex` is the reference. */
export interface Index {
  message(ref: MessageRef): Message | undefined;
  /** The conversations of an account with a message that links through any of these ids. */
  linkedConversations(account: AccountId, ids: readonly string[]): readonly ConversationId[];
  conversation(id: ConversationId): readonly Message[];
  folder(folder: FolderRef): readonly Message[];
  role(folder: FolderRef): FolderRole | undefined;
}

/** The rows to write: messages to insert or replace by ref, then refs to delete. */
type IndexChange = { put: Message[]; remove: MessageRef[] };

export function applySyncEvent(index: Index, event: SyncEvent): IndexChange {
  switch (event.type) {
    case 'message':
      return receive(index, event.envelope);
    case 'flags':
      return reflag(index.message(event.ref), event.flags);
    case 'gone': {
      const held = index.message(event.ref);
      return held ? forget(index, [held]) : NOTHING;
    }
    case 'reset':
      return forget(index, index.folder(event.folder));
  }
}

const NOTHING: IndexChange = { put: [], remove: [] };

/**
 * A new message joins every conversation it links to, under the smallest root among them. Adding
 * a message can only merge conversations, never split one, so only the messages whose conversation
 * is renamed are read and rewritten.
 */
function receive(index: Index, envelope: Envelope): IndexChange {
  const held = index.message(envelope);
  if (held) return reread(held, envelope);

  const gathering = gatheringOf(envelope, index.role(envelope));
  const roots = new Map<ConversationId, string>();
  for (const id of index.linkedConversations(envelope.account, linkIdsOf(envelope))) {
    const parts = partsOf(id);
    if (parts?.gathering === gathering) roots.set(id, parts.root);
  }
  const root = [...roots.values()].reduce(
    (least, root) => (root < least ? root : least),
    rootOf(envelope),
  );
  const conversation = conversationIdOf(envelope.account, gathering, root);
  const renamed = [...roots.keys()]
    .filter((id) => id !== conversation)
    .flatMap((id) => index.conversation(id))
    .map((message) => ({ ...message, conversation }));
  return { put: [{ ...envelope, conversation }, ...renamed], remove: [] };
}

/**
 * What a server says of a message never changes for its ref but its flags, but how it is read can,
 * as when its preview or its sender's verdict is read better since. A message held takes the
 * envelope read again, in the conversation it is in, and nothing changes if it reads the same.
 * What it links through stays as it was first read, so its conversation never depends on when.
 */
function reread({ conversation, ...held }: Message, envelope: Envelope): IndexChange {
  const read = { ...envelope, messageId: held.messageId, references: held.references };
  if (canonical(held) === canonical(read)) return NOTHING;
  return { put: [{ ...read, conversation }], remove: [] };
}

/** A value as JSON with every object's keys in order, so two that hold the same read the same. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_, part: unknown) =>
    part && typeof part === 'object' && !Array.isArray(part)
      ? Object.fromEntries(Object.entries(part).toSorted(([a], [b]) => a.localeCompare(b)))
      : part,
  );
}

function reflag(held: Message | undefined, flags: Flags): IndexChange {
  if (!held || sameFlags(held.flags, flags)) return NOTHING;
  return { put: [{ ...held, flags: { ...flags } }], remove: [] };
}

/**
 * Removing messages can split a conversation, so each conversation they leave is linked again from
 * the messages that remain, exactly as if the removed ones had never arrived.
 */
function forget(index: Index, held: readonly Message[]): IndexChange {
  if (held.length === 0) return NOTHING;
  const removed = new Set(held.map(keyOf));
  const put: Message[] = [];
  for (const id of new Set(held.map((message) => message.conversation))) {
    const parts = partsOf(id);
    const rest = index.conversation(id).filter((message) => !removed.has(keyOf(message)));
    if (!parts || rest.length === 0) continue;
    linkConversations(parts.account, parts.gathering, rest).forEach((conversation, i) => {
      const message = rest[i]!;
      if (conversation !== message.conversation) put.push({ ...message, conversation });
    });
  }
  return { put, remove: held.map(refOf) };
}

/**
 * The reference `Index`: an immutable value in memory. The Mailroom's SQLite index must answer
 * every read as this one does, and `apply` writes a change the way the Mailroom must.
 */
export type MemoryIndex = Index & {
  readonly messages: readonly Message[];
  apply(change: IndexChange): MemoryIndex;
};

export function memoryIndex(
  folders: readonly (FolderRef & { role?: FolderRole })[],
  messages: readonly Message[] = [],
): MemoryIndex {
  const byKey = new Map(messages.map((message) => [keyOf(message), message]));
  const inFolder = (folder: FolderRef) => (candidate: FolderRef) =>
    candidate.account === folder.account && candidate.path === folder.path;
  return {
    messages,
    message: (ref) => byKey.get(keyOf(ref)),
    linkedConversations: (account, ids) => {
      const linking = new Set(ids);
      const linked = messages.filter(
        (message) =>
          message.account === account && linkIdsOf(message).some((id) => linking.has(id)),
      );
      return [...new Set(linked.map((message) => message.conversation))];
    },
    conversation: (id) => messages.filter((message) => message.conversation === id),
    folder: (folder) => messages.filter(inFolder(folder)),
    role: (folder) => folders.find(inFolder(folder))?.role,
    apply: (change) => {
      const replaced = new Set([...change.remove, ...change.put].map(keyOf));
      return memoryIndex(folders, [
        ...messages.filter((message) => !replaced.has(keyOf(message))),
        ...change.put,
      ]);
    },
  };
}

function refOf({ account, path, uidValidity, uid }: MessageRef): MessageRef {
  return { account, path, uidValidity, uid };
}

function keyOf(ref: MessageRef): string {
  return JSON.stringify([ref.account, ref.path, ref.uidValidity, ref.uid]);
}

function sameFlags(a: Flags, b: Flags): boolean {
  return (
    a.seen === b.seen && a.flagged === b.flagged && a.answered === b.answered && a.draft === b.draft
  );
}
