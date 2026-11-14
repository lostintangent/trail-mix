import {
  linkIdsOf,
  refKey,
  sameFolder,
  type FolderRef,
  type FolderRole,
  type Index,
  type IndexChange,
  type Message,
} from '../src/features/mail/core/index.ts';

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
  const byKey = new Map(messages.map((message) => [refKey(message), message]));
  return {
    messages,
    message: (ref) => byKey.get(refKey(ref)),
    linkedConversations: (account, ids) => {
      const linking = new Set(ids);
      const linked = messages.filter(
        (message) =>
          message.account === account && linkIdsOf(message).some((id) => linking.has(id)),
      );
      return [...new Set(linked.map((message) => message.conversation))];
    },
    conversation: (id) => messages.filter((message) => message.conversation === id),
    folder: (folder) => messages.filter((message) => sameFolder(message, folder)),
    role: (folder) => folders.find((candidate) => sameFolder(candidate, folder))?.role,
    apply: (change) => {
      const replaced = new Set([...change.remove, ...change.put].map(refKey));
      return memoryIndex(folders, [
        ...messages.filter((message) => !replaced.has(refKey(message))),
        ...change.put,
      ]);
    },
  };
}
