import { QueryClient } from '@tanstack/react-query';

/**
 * The browser's cache of server snapshots. A snapshot stays current until something marks it
 * stale, so nothing refetches on a timer, on focus, or because a component mounted again.
 */
export const createQueryClient = () =>
  new QueryClient({
    defaultOptions: {
      queries: { staleTime: Infinity, refetchOnWindowFocus: false, refetchOnReconnect: false },
    },
  });
