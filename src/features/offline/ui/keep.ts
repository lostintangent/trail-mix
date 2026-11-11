import {
  experimental_createQueryPersister,
  type AsyncStorage,
  type PersistedQuery,
} from '@tanstack/query-persist-client-core';
import { QueryObserver, type QueryClient, type QueryPersister } from '@tanstack/react-query';
import { thisDeviceQuery } from '../../mailroom/client/index.ts';
import { evictions, isKept, KEEP_FOR_MS, keptOf, type Kept } from '../core/kept.ts';
import { snapshots } from './store.ts';

/** Changes when a kept snapshot's shape does, which drops everything kept before. */
const SHAPE = '2';
/** Whose Mailroom the kept snapshots came from, as `thisDevice` names it. */
const OWNER_KEY = 'trail-mix.cache';
const PREFIX = 'snapshot';

/**
 * The persister that keeps what the installed app sees and shows it before the network answers,
 * or when it can't. Each snapshot is restored the first time the app asks for it, then fetched
 * again.
 *
 * Kept snapshots belong to one Mailroom. Online, the app asks the Mailroom's name before showing
 * any, and drops them all if it has changed, as after an erase or a different member signing in.
 * With no network or no sign-in it can't ask, and shows what it kept.
 */
export function keeperFor(queryClient: QueryClient): QueryPersister {
  const persister = experimental_createQueryPersister<Kept>({
    storage: snapshots as AsyncStorage<Kept>,
    maxAge: KEEP_FOR_MS,
    buster: SHAPE,
    prefix: PREFIX,
    // A restored snapshot is fetched again below, since the persister's own refetch leaves its
    // failure uncaught, and with no network it fails.
    refetchOnRestore: false,
    serialize: (persisted) => keptOf(persisted),
    deserialize: (kept) => kept as unknown as PersistedQuery,
  });
  const isOwners = ownerOf(queryClient);
  void isOwners.then(async (isOwner) => {
    if (!isOwner) return;
    await navigator.storage?.persist?.().catch(() => false);
    await persister.persisterGc();
    await evict();
  });
  return async (queryFn, context, query) => {
    if (!isKept(query.queryKey) || !(await isOwners)) return queryFn(context);
    let isFetched = false;
    const data = await persister.persisterFn(
      (fetching) => {
        isFetched = true;
        return queryFn(fetching);
      },
      context,
      query,
    );
    // Once the restore is done, its snapshot is fetched again. With no network that waits, and a
    // failure leaves the snapshot showing.
    if (!isFetched) setTimeout(() => void query.fetch().catch(() => {}));
    return data;
  };
}

/** Whether what this device kept is the Mailroom's that answers now, and so may show. */
async function ownerOf(queryClient: QueryClient): Promise<boolean> {
  const kept = readOwner();
  try {
    // Asked once, at once, whether or not the browser thinks it's online.
    const { cache } = await queryClient.fetchQuery({
      ...thisDeviceQuery,
      retry: false,
      networkMode: 'always',
    });
    if (cache !== kept) await forget(cache);
  } catch {
    return kept !== undefined;
  }
  // An erase while open names the Mailroom anew, and the hint it sends has this refetched.
  new QueryObserver(queryClient, thisDeviceQuery).subscribe(({ data }) => {
    if (data && data.cache !== readOwner()) void forget(data.cache);
  });
  return true;
}

async function forget(owner: string) {
  await snapshots.clear();
  try {
    localStorage.setItem(OWNER_KEY, owner);
  } catch {
    // Without storage the device asks again on its next start, and keeps nothing until then.
  }
}

function readOwner(): string | undefined {
  try {
    return localStorage.getItem(OWNER_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

/** Drops the bodies past what the app keeps, those fetched longest ago first. */
async function evict() {
  const held = (await snapshots.entries()).flatMap(([key, value]) => {
    const kept = value as Partial<Kept> | undefined;
    if (!key.startsWith(`${PREFIX}-`) || !kept?.queryKey || !kept.state) return [];
    return [{ key, kind: kept.queryKey[0], at: kept.state.dataUpdatedAt, bytes: kept.bytes ?? 0 }];
  });
  for (const key of evictions(held)) await snapshots.removeItem(key);
}
