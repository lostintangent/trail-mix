import { infiniteQueryOptions, queryOptions } from '@tanstack/react-query';
import type { ConversationId, FolderRef, Hint, MessageRef, View } from '../../mail/core/index.ts';
import type { PageCursor } from './contract.ts';
import { mailroom } from './rpc.ts';

/** What each query's snapshot is cached under. */
export const keys = {
  accounts: ['accounts'],
  folders: ['folders'],
  outbox: ['outbox'],
  conversations: (view: View) => ['conversations', view] as const,
  conversation: (id: ConversationId) => ['conversation', id] as const,
  body: (ref: MessageRef) => ['body', ref] as const,
} as const;

export type Key =
  | typeof keys.accounts
  | typeof keys.folders
  | typeof keys.outbox
  | ReturnType<typeof keys.conversations>
  | ReturnType<typeof keys.conversation>
  | ReturnType<typeof keys.body>;

/**
 * Whether a hint leaves a snapshot out of date. A change to a folder's mail changes its counts and
 * its list, every view across accounts, which may hold its mail, any open conversation, which the
 * hint can't name, and the Outbox, which names the conversation each draft on its way is in. A body
 * never changes for its message, so no hint touches one.
 */
export function isStale(key: Key, hint: Hint): boolean {
  switch (hint.changed) {
    case 'accounts':
      return key[0] === 'accounts';
    case 'folders':
      return key[0] === 'folders';
    case 'outbox':
      return key[0] === 'outbox';
    case 'conversations':
      return (
        key[0] === 'folders' ||
        key[0] === 'conversation' ||
        key[0] === 'outbox' ||
        (key[0] === 'conversations' &&
          (key[1].in !== 'folder' || isSameFolder(key[1].folder, hint.folder)))
      );
  }
}

const isSameFolder = (a: FolderRef, b: FolderRef) => a.account === b.account && a.path === b.path;

/**
 * Each query as options for TanStack Query, to read with `useQuery` or fetch ahead with
 * `ensureQueryData`.
 */
export const accountsQuery = queryOptions({
  queryKey: keys.accounts,
  queryFn: () => mailroom.accounts(),
});

export const foldersQuery = queryOptions({
  queryKey: keys.folders,
  queryFn: () => mailroom.folders(),
});

export const outboxQuery = queryOptions({
  queryKey: keys.outbox,
  queryFn: () => mailroom.outbox(),
});

/** A view's conversations, newest first, a page at a time, for `useInfiniteQuery`. */
export const conversationsQuery = (view: View) =>
  infiniteQueryOptions({
    queryKey: keys.conversations(view),
    queryFn: ({ pageParam }) => mailroom.conversations(view, pageParam),
    initialPageParam: undefined as PageCursor | undefined,
    getNextPageParam: (page) => page.next,
  });

export const conversationQuery = (id: ConversationId) =>
  queryOptions({ queryKey: keys.conversation(id), queryFn: () => mailroom.conversation(id) });

export const bodyQuery = (ref: MessageRef) =>
  queryOptions({ queryKey: keys.body(ref), queryFn: () => mailroom.body(ref) });
