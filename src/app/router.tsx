import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import { createRouter } from '@tanstack/react-router';
import { readQuery, writeQuery } from '../features/mail/core/index.ts';
import { isInstalled, keepSnapshots } from '../features/offline/index.ts';
import { createQueryClient } from '../shared/query-client.ts';
import { routeTree } from './routeTree.gen.ts';

/** What every route can reach: the cache of the Mailroom's snapshots, for loaders to fill early. */
export type RouterContext = { queryClient: QueryClient };

export function getRouter() {
  const queryClient = createQueryClient();
  // The installed app keeps what it sees, and opens to it with no network.
  if (typeof window !== 'undefined' && isInstalled()) keepSnapshots(queryClient);
  return createRouter({
    routeTree,
    context: { queryClient } satisfies RouterContext,
    // The address's query holds a place, written and read as the place's own codec does.
    parseSearch: readQuery,
    stringifySearch: writeQuery,
    Wrap: ({ children }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    ),
  });
}
