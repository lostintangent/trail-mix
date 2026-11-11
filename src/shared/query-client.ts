import { QueryClient } from '@tanstack/react-query';
import { isUnreached } from './reasons.ts';

/**
 * The browser's cache of server snapshots. A snapshot stays current until something marks it
 * stale, so nothing refetches on a timer, on focus, or because a component mounted again.
 */
export const createQueryClient = () =>
  new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: Infinity,
        refetchOnWindowFocus: false,
        refetchOnReconnect: false,
        retry: asksAgain,
      },
    },
  });

/**
 * Whether a query that failed asks again: up to three times, as TanStack Query would, but not when
 * its request got no answer while the browser says it's offline, which asking again can't change.
 * TanStack takes a page to be online until the browser says otherwise, and a page that starts
 * offline is never told, so it would wait out every try, seven seconds, before it failed. A
 * browser that says it's online may still lose a request, as a phone does, and asks it again.
 */
export function asksAgain(
  failures: number,
  error: unknown,
  isOffline = typeof navigator !== 'undefined' && navigator.onLine === false,
): boolean {
  return failures < 3 && !(isOffline && isUnreached(error));
}
