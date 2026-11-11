import { queryOptions } from '@tanstack/react-query';
import { asksAgain } from '../../../shared/query-client.ts';
import type { ConversationId, FolderRef, Hint, MessageRef, View } from '../../mail/core/index.ts';
import { mailroom, type Unanswered } from './rpc.ts';

/** What each query's snapshot is cached under. */
export const keys = {
  accounts: ['accounts'],
  // Under accounts, so the accounts hint, which names every sign-in's change, refetches them too.
  signIns: ['accounts', 'sign-ins'],
  // How the deployment is set up, which no hint changes.
  signInPresets: ['sign-in-presets'],
  // As `notified` is without an endpoint, since the Mailroom answers both alike, so it's asked once.
  thisDevice: ['this-device', null],
  folders: ['folders'],
  outbox: ['outbox'],
  /** Under this device, so an erase, which makes the Mailroom anew, asks again. */
  notified: (endpoint: string | undefined) => ['this-device', endpoint ?? null] as const,
  // A view's list, under which each of its pages is kept by the place it starts at.
  conversations: (view: View) => ['conversations', view] as const,
  page: (view: View, at: number) => ['conversations', view, at] as const,
  conversation: (id: ConversationId) => ['conversation', id] as const,
  body: (ref: MessageRef) => ['body', ref] as const,
} as const;

export type Key =
  | typeof keys.accounts
  | typeof keys.signIns
  | typeof keys.signInPresets
  | typeof keys.thisDevice
  | ReturnType<typeof keys.notified>
  | typeof keys.folders
  | typeof keys.outbox
  | ReturnType<typeof keys.conversations>
  | ReturnType<typeof keys.page>
  | ReturnType<typeof keys.conversation>
  | ReturnType<typeof keys.body>;

/**
 * Whether a hint leaves a snapshot out of date. A change to a folder's mail changes its counts and
 * its list, every view across accounts, which may hold its mail, any open conversation, which the
 * hint can't name, and the Outbox, which names the conversation each draft on its way is in. A
 * sender's picture that came, changed or went changes the lists and conversations that name it. A body never
 * changes for its message, so no hint but an erase touches one.
 */
export function isStale(key: Key, hint: Hint): boolean {
  switch (hint.changed) {
    case 'accounts':
      return key[0] === 'accounts';
    case 'folders':
      return key[0] === 'folders';
    case 'outbox':
      return key[0] === 'outbox';
    case 'avatars':
      return key[0] === 'conversations' || key[0] === 'conversation';
    case 'everything':
      return true;
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
  // The public demo answers 429 while it lets no more visitors in, which asking again won't change.
  retry: (failures, error: Unanswered) => error.status !== 429 && asksAgain(failures, error),
});

/**
 * Sign-ins under way. A member who went to the vendor's page in another tab or app comes back to
 * this one, so it refetches then too, in case the hint that finished it came while it slept.
 */
export const signInsQuery = queryOptions({
  queryKey: keys.signIns,
  queryFn: () => mailroom.signIns(),
  refetchOnWindowFocus: true,
});

export const signInPresetsQuery = queryOptions({
  queryKey: keys.signInPresets,
  queryFn: () => mailroom.signInPresets(),
});

/** What this device keeps of the Mailroom, which changes only when the Mailroom is made anew. */
export const thisDeviceQuery = queryOptions({
  queryKey: keys.thisDevice,
  queryFn: () => mailroom.thisDevice(),
});

/**
 * Whether the device at `endpoint` is notified, and the key a device subscribes with, which is
 * absent where notifications are off. Without an endpoint, a device isn't subscribed.
 */
export const notifiedQuery = (endpoint: string | undefined) =>
  queryOptions({
    queryKey: keys.notified(endpoint),
    queryFn: () => mailroom.thisDevice(endpoint),
  });

export const foldersQuery = queryOptions({
  queryKey: keys.folders,
  queryFn: () => mailroom.folders(),
});

export const outboxQuery = queryOptions({
  queryKey: keys.outbox,
  queryFn: () => mailroom.outbox(),
});

/** The page of a view's list from its place `at`, newest first, with how long the list is. */
export const conversationsQuery = (view: View, at = 0) =>
  queryOptions({
    queryKey: keys.page(view, at),
    queryFn: () => mailroom.conversations(view, at),
  });

export const conversationQuery = (id: ConversationId) =>
  queryOptions({ queryKey: keys.conversation(id), queryFn: () => mailroom.conversation(id) });

export const bodyQuery = (ref: MessageRef) =>
  queryOptions({ queryKey: keys.body(ref), queryFn: () => mailroom.body(ref) });
