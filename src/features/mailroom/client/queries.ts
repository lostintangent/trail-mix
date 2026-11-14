import { queryOptions } from '@tanstack/react-query';
import { asksAgain } from '../../../shared/query-client.ts';
import {
  bundlePartsOf,
  sameFolder,
  type BundleId,
  type ConversationId,
  type Hint,
  type MessageRef,
  type View,
} from '../../mail/core/index.ts';
import type { PageAt } from './contract.ts';
import { mailroom, type Unanswered } from './rpc.ts';

/** What each query's snapshot is cached under. */
export const keys = {
  accounts: ['accounts'],
  // Under accounts, so the accounts hint, which names every sign-in's change, refetches them too.
  signIns: ['accounts', 'sign-ins'],
  // How the deployment is set up, which no hint changes.
  signInPresets: ['sign-in-presets'],
  folders: ['folders'],
  outbox: ['outbox'],
  /** Under this device, so an erase, which makes the Mailroom anew, asks again. */
  notified: (endpoint: string | undefined) => ['this-device', endpoint ?? null] as const,
  // A view's list, under which each of its pages is kept by the place it starts at, or by the row
  // it was asked for around.
  conversations: (view: View) => ['conversations', view] as const,
  page: (view: View, at: PageAt) => ['conversations', view, at] as const,
  // A bundle's threads, under which each of its pages is kept as a view's are.
  bundle: (id: BundleId) => ['bundle', id] as const,
  bundlePage: (id: BundleId, at: PageAt) => ['bundle', id, at] as const,
  conversation: (id: ConversationId) => ['conversation', id] as const,
  body: (ref: MessageRef) => ['body', ref] as const,
  people: (typed: string) => ['people', typed] as const,
} as const;

/** Every key a snapshot is cached under: each of `keys`, or what each of its functions makes. */
export type Key = Made<(typeof keys)[keyof typeof keys]>;
type Made<K> = K extends (...args: never[]) => infer Made ? Made : K;

/**
 * Whether a hint leaves a snapshot out of date. A change to a folder's mail changes its counts and
 * its list, every view across accounts, which may hold its mail, any open conversation, which the
 * hint can't name, and the Outbox, which names the conversation each draft on its way is in, and
 * its account's bundles, which lie in its Inbox. A sender's picture that came, changed or went
 * changes the lists and conversations that name it. Whom an address field completes to follows the
 * mail, and the member's addresses, which are their accounts'. A body never changes for its
 * message, so no hint but an erase touches one.
 */
export function isStale(key: Key, hint: Hint): boolean {
  if (hint.changed === 'everything' || STALE[hint.changed].includes(key[0])) return true;
  return (
    hint.changed === 'conversations' &&
    ((key[0] === 'bundle' && bundlePartsOf(key[1])?.account === hint.folder.account) ||
      (key[0] === 'conversations' &&
        (key[1].in !== 'folder' || sameFolder(key[1].folder, hint.folder))))
  );
}

/** What each hint leaves out of date whatever it names, by the name its key starts with. */
const STALE: Record<Exclude<Hint['changed'], 'everything'>, readonly Key[0][]> = {
  accounts: ['accounts', 'people'],
  folders: ['folders'],
  outbox: ['outbox'],
  avatars: ['conversations', 'bundle', 'conversation'],
  // And the folder's list, the views across accounts and the account's bundles, as above.
  conversations: ['folders', 'conversation', 'people', 'outbox'],
};

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

/**
 * Whether the device at `endpoint` is notified, and the key a device subscribes with, which is
 * absent where notifications are off. Without an endpoint, a device isn't subscribed.
 */
export const notifiedQuery = (endpoint: string | undefined) =>
  queryOptions({
    queryKey: keys.notified(endpoint),
    queryFn: () => mailroom.thisDevice(endpoint),
  });

/**
 * What this device keeps of the Mailroom, which changes only when the Mailroom is made anew. It's
 * `notified` without an endpoint, since the Mailroom answers both alike, so it's asked once.
 */
export const thisDeviceQuery = notifiedQuery(undefined);

export const foldersQuery = queryOptions({
  queryKey: keys.folders,
  queryFn: () => mailroom.folders(),
});

export const outboxQuery = queryOptions({
  queryKey: keys.outbox,
  queryFn: () => mailroom.outbox(),
});

/**
 * The page of a view's list from its place `at`, or the one holding a row, newest first, with how
 * long the list is. A list of unread mail also holds the conversation or bundle `keep` names, which
 * the member has open. The page is kept under the view's key alone, whatever it kept, since keeping
 * changes only that row.
 */
export const conversationsQuery = (view: View, at: PageAt = 0, keep?: ConversationId) =>
  queryOptions({
    queryKey: keys.page(view, at),
    queryFn: () => mailroom.conversations(view, at, keep),
  });

/**
 * A page of a bundle's threads, newest first, from the place `at` or the one holding a thread, with
 * the bundle's row.
 */
export const bundleQuery = (id: BundleId, at: PageAt = 0) =>
  queryOptions({ queryKey: keys.bundlePage(id, at), queryFn: () => mailroom.bundle(id, at) });

export const conversationQuery = (id: ConversationId) =>
  queryOptions({ queryKey: keys.conversation(id), queryFn: () => mailroom.conversation(id) });

export const bodyQuery = (ref: MessageRef) =>
  queryOptions({ queryKey: keys.body(ref), queryFn: () => mailroom.body(ref) });

/** Whom an address field completes `typed` to, best first. */
export const peopleQuery = (typed: string) =>
  queryOptions({ queryKey: keys.people(typed), queryFn: () => mailroom.people(typed) });
