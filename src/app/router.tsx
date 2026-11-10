import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import { createRouter } from '@tanstack/react-router';
import { createQueryClient } from '../shared/query-client.ts';
import { routeTree } from './routeTree.gen.ts';

/** What every route can reach: the cache of the Mailroom's snapshots, for loaders to fill early. */
export type RouterContext = { queryClient: QueryClient };

export function getRouter() {
  const queryClient = createQueryClient();
  return createRouter({
    routeTree,
    context: { queryClient } satisfies RouterContext,
    Wrap: ({ children }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    ),
  });
}
