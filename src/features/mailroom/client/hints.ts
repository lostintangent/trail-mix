import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import type { Hint } from '../../mail/core/index.ts';
import { isStale, type Key } from './queries.ts';

/**
 * Keeps what's on screen current while Trail Mix is open, through one WebSocket per tab to the
 * member's Mailroom. Each hint makes stale the snapshots it names, and those on screen refetch.
 * Hints sent while the socket isn't open are lost, before it first opens as after it drops, so each
 * time it opens everything refetches. A new Mailroom, as a demo visitor's first query makes, can
 * fill before the socket that page opened reaches it.
 *
 * A refetch starts at once for a hint, and hints that follow within `SETTLE_MS` wait to refetch
 * together. A refetch that a new one replaces is dropped, so during a burst of hints, as a first
 * sync sends, refetching for each would leave the lists on their first, empty snapshot until the
 * burst ends.
 */
export function useHints(): void {
  const queryClient = useQueryClient();
  useEffect(() => listen(queryClient), [queryClient]);
}

export function listen(queryClient: QueryClient): () => void {
  let socket: WebSocket | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let failures = 0;
  let isDone = false;
  /** Hints heard since the last refetch, waiting for theirs, and when that refetch started. */
  let waiting: Hint[] = [];
  let refetching: ReturnType<typeof setTimeout> | undefined;
  let refetchedAt = -Infinity;

  const refetch = () => {
    const hints = waiting;
    waiting = [];
    refetching = undefined;
    refetchedAt = Date.now();
    void queryClient.invalidateQueries({
      predicate: ({ queryKey }) => hints.some((hint) => isStale(queryKey as unknown as Key, hint)),
    });
  };
  const heard = (hint: Hint) => {
    waiting.push(hint);
    if (refetching) return;
    refetching = setTimeout(refetch, Math.max(0, refetchedAt + SETTLE_MS - Date.now()));
  };

  const connect = () => {
    clearTimeout(retry);
    if (isDone || (socket && socket.readyState <= WebSocket.OPEN)) return;
    socket = new WebSocket(new URL('/updates', location.href.replace(/^http/, 'ws')));
    socket.onopen = () => {
      failures = 0;
      void queryClient.invalidateQueries();
    };
    socket.onmessage = ({ data }) => {
      const hint = readHint(data);
      if (hint) heard(hint);
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
    clearTimeout(refetching);
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

/** How long a refetch for hints is left to finish before hints after it start another. */
export const SETTLE_MS = 250;

/** Up to half a minute between attempts, spread out so every tab doesn't return at once. */
const retryDelay = (failures: number) =>
  Math.min(30_000, 1_000 * 2 ** failures) * (0.5 + Math.random() / 2);
