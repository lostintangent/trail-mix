import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import type { Hint } from '../../mail/core/index.ts';
import { isStale, type Key } from './queries.ts';

/**
 * Keeps what's on screen current while Trail Mix is open, through one WebSocket per tab to the
 * member's Mailroom. Each hint makes stale the snapshots it names, and those on screen refetch.
 * Hints sent while the socket was down are lost, so after every reconnect everything refetches.
 */
export function useHints(): void {
  const queryClient = useQueryClient();
  useEffect(() => listen(queryClient), [queryClient]);
}

function listen(queryClient: QueryClient): () => void {
  let socket: WebSocket | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let failures = 0;
  let hasConnected = false;
  let isDone = false;

  const connect = () => {
    clearTimeout(retry);
    if (isDone || (socket && socket.readyState <= WebSocket.OPEN)) return;
    socket = new WebSocket(new URL('/updates', location.href.replace(/^http/, 'ws')));
    socket.onopen = () => {
      failures = 0;
      if (hasConnected) void queryClient.invalidateQueries();
      hasConnected = true;
    };
    socket.onmessage = ({ data }) => {
      const hint = readHint(data);
      if (!hint) return;
      void queryClient.invalidateQueries({
        predicate: ({ queryKey }) => isStale(queryKey as unknown as Key, hint),
      });
    };
    socket.onclose = () => {
      if (!isDone) retry = setTimeout(connect, retryDelay(failures++));
    };
  };

  // A phone drops the socket in the background, so coming back or back online reconnects at once.
  const reconnect = () => {
    if (document.visibilityState === 'visible') connect();
  };
  addEventListener('online', reconnect);
  document.addEventListener('visibilitychange', reconnect);
  connect();

  return () => {
    isDone = true;
    clearTimeout(retry);
    socket?.close();
    removeEventListener('online', reconnect);
    document.removeEventListener('visibilitychange', reconnect);
  };
}

/** One hint per message, as JSON. Anything else is ignored. */
function readHint(data: unknown): Hint | undefined {
  try {
    const hint: unknown = JSON.parse(String(data));
    return typeof hint === 'object' && hint !== null && 'changed' in hint
      ? (hint as Hint)
      : undefined;
  } catch {
    return undefined;
  }
}

/** Up to half a minute between attempts, spread out so every tab doesn't return at once. */
const retryDelay = (failures: number) =>
  Math.min(30_000, 1_000 * 2 ** failures) * (0.5 + Math.random() / 2);
