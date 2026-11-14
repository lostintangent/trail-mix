import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useEffect, useSyncExternalStore } from 'react';
import type { Hint } from '../../mail/core/index.ts';
import { isStale, type Key } from './queries.ts';

/**
 * Keeps what's on screen current while Trail Mix is open, through one WebSocket per tab to the
 * member's Mailroom. Each hint makes stale the snapshots it names, and those on screen refetch.
 * Hints sent while the socket isn't open are lost, before it first opens as after it drops, so each
 * time it opens everything refetches. A new Mailroom, as a demo visitor's first query makes, can
 * fill before the socket that page opened reaches it.
 *
 * A refetch waits `GATHER_MS` after a hint for the others its change sends, as a conversation in
 * two folders sends one for each, so they refetch together rather than buying a second round.
 * Hints that follow within `SETTLE_MS` of a refetch wait to refetch together after it. A refetch
 * that a new one replaces is dropped, so during a burst of hints, as a first sync sends, refetching
 * for each would leave the lists on their first, empty snapshot until the burst ends.
 */
export function useHints(): void {
  const queryClient = useQueryClient();
  useEffect(() => listen(queryClient), [queryClient]);
}

/**
 * Whether the page has caught up with its Mailroom: its socket has opened and what the page asked
 * before then has been asked again. Until then a snapshot may be from before a change whose hint
 * it missed, so the page claims neither that it's up to date nor that a list is empty. A socket
 * that can't open at all leaves nothing to wait for, and the page trusts what it has.
 */
export function useIsCaughtUp(): boolean {
  const caught = caughtUpWith(useQueryClient());
  return useSyncExternalStore(caught.watch, () => caught.is);
}

/** Whether the page holding `queryClient` has caught up with its Mailroom. */
export const isCaughtUp = (queryClient: QueryClient) => caughtUpWith(queryClient).is;

type CaughtUp = { is: boolean; watch: (watcher: () => void) => () => void; now: () => void };
const caughtUps = new WeakMap<QueryClient, CaughtUp>();

function caughtUpWith(queryClient: QueryClient): CaughtUp {
  const held = caughtUps.get(queryClient);
  if (held) return held;
  const watchers = new Set<() => void>();
  const caught: CaughtUp = {
    is: false,
    watch: (watcher) => {
      watchers.add(watcher);
      return () => void watchers.delete(watcher);
    },
    now: () => {
      if (caught.is) return;
      caught.is = true;
      for (const watcher of watchers) watcher();
    },
  };
  caughtUps.set(queryClient, caught);
  return caught;
}

export function listen(queryClient: QueryClient): () => void {
  const caught = caughtUpWith(queryClient);
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
    refetching = setTimeout(refetch, Math.max(GATHER_MS, refetchedAt + SETTLE_MS - Date.now()));
  };

  const connect = () => {
    clearTimeout(retry);
    if (isDone || (socket && socket.readyState <= WebSocket.OPEN)) return;
    socket = new WebSocket(new URL('/updates', location.href.replace(/^http/, 'ws')));
    socket.onopen = () => {
      failures = 0;
      void queryClient.invalidateQueries().finally(caught.now);
    };
    socket.onmessage = ({ data }) => {
      const hint = readHint(data);
      if (hint) heard(hint);
    };
    socket.onclose = () => {
      // Closed before it ever opened, it may never open, and the page has nothing more to wait for.
      caught.now();
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

/** How long a hint waits for the others its change sends, before they refetch together. */
const GATHER_MS = 50;

/** How long a refetch for hints is left to finish before hints after it start another. */
export const SETTLE_MS = 250;

/** Up to half a minute between attempts, spread out so every tab doesn't return at once. */
const retryDelay = (failures: number) =>
  Math.min(30_000, 1_000 * 2 ** failures) * (0.5 + Math.random() / 2);
