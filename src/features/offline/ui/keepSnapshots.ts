import type { QueryClient, QueryPersister } from '@tanstack/react-query';

/**
 * Has the installed app keep what it sees, so it opens to it with no network. The keeping itself
 * loads apart from the first screen's code, which a browser's tab never needs.
 */
export function keepSnapshots(queryClient: QueryClient): void {
  const keeper = import('./keep.ts').then(({ keeperFor }) => keeperFor(queryClient));
  const keep: QueryPersister = async (queryFn, context, query) =>
    (await keeper)(queryFn, context, query);
  const defaults = queryClient.getDefaultOptions();
  queryClient.setDefaultOptions({
    ...defaults,
    // A query offline still runs once, so what was kept can answer it, and waits for the network
    // only to fetch again.
    queries: { ...defaults.queries, networkMode: 'offlineFirst', persister: keep },
  });
}
