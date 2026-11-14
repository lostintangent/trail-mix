import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  BundleId,
  BundleSummary,
  ConversationId,
  ConversationSummary,
  Place,
} from '../../mail/core/index.ts';
import { bundleQuery } from '../../mailroom/client/index.ts';
import { placesOf, type Listed } from '../core/pages.ts';
import { useTriagedList } from './overlays.ts';
import { useAround, usePages, type Show } from './useConversations.ts';

/** No bundle open. */
const NONE = '';

/**
 * A bundle as the reader shows it: the row it stands as and its threads, newest first, with the
 * triage still on its way laid over them. Its threads are a list a page at a time, as a view's
 * are: as long as the bundle from its first page, with the pages the reader shows fetched.
 */
export function useBundle(id: BundleId | undefined): {
  bundle: BundleSummary | undefined;
  threads: Listed<ConversationSummary> | undefined;
  /** Where each thread that has arrived lies among them. */
  places: ReadonlyMap<string, number>;
  /** Says which threads the reader shows, or which lie beside the one open, so they are fetched. */
  show: Show;
  /** Whether a page the reader shows is on its way, which holds the threads as they were. */
  isFetching: boolean;
  /** Whether the bundle is on its way, or was asked for and refused. */
  isPending: boolean;
  isError: boolean;
  refetch: () => void;
} {
  const enabled = id !== undefined;
  const first = useQuery({ ...bundleQuery(id ?? NONE), enabled });
  const { rows, isFetching, show } = usePages(id ?? NONE, {
    pageAt: (at) => bundleQuery(id ?? NONE, at),
    isFirstFetching: first.isFetching,
    enabled,
  });
  const threads = useTriagedList(id ?? NONE, enabled ? rows : undefined);
  const places = useMemo(
    () => (threads ? placesOf(threads) : new Map<string, number>()),
    [threads],
  );
  return {
    bundle: first.data?.bundle,
    threads,
    places,
    show,
    isFetching,
    isPending: first.isPending,
    isError: first.isError,
    refetch: () => void first.refetch(),
  };
}

/** A thread open in its bundle. */
type OpenThread = { bundle: BundleId; open: ConversationId };

/**
 * How many threads on each side of the one open are fetched, so a held J or K finds the next page
 * there before it reaches it.
 */
const THREADS_AHEAD = 10;

/**
 * The thread open in the bundle selected, if one is: the bundle as the reader shows it, and where the
 * thread lies among its threads. A thread stays open until the selection moves on from its bundle,
 * and the bundle remembers the thread last open in it, to show it in sight when the member returns.
 * A thread a place arrives naming deeper in its bundle than the pages it holds is asked for, as a
 * conversation is in a list, so J steps on from it, and the bundle waits for it too, so closing the
 * thread before its page came shows it in sight.
 */
export function useOpenThread(
  bundle: BundleId | undefined,
  /** The place the workbench opened at, whose thread is open from the first render. */
  place: Place,
) {
  const [threadIn, setThreadIn] = useState(() => threadNamedBy(place));
  if (threadIn !== undefined && threadIn.bundle !== bundle) setThreadIn(undefined);
  const thread = threadIn?.bundle === bundle ? threadIn?.open : undefined;
  const inBundle = useBundle(bundle);
  const threadAt = thread === undefined ? -1 : (inBundle.places.get(thread) ?? -1);
  const threadRow = inBundle.threads?.[threadAt];
  // While a thread is open, the threads beside it are fetched at once, so J and K step on past its
  // page without waiting.
  const showThreads = inBundle.show;
  useEffect(() => {
    if (threadAt >= 0) {
      showThreads(threadAt - THREADS_AHEAD, threadAt + THREADS_AHEAD, threadAt, true);
    }
  }, [showThreads, threadAt]);
  const [cameFrom, setCameFrom] = useState(threadIn);
  if (thread !== undefined && cameFrom?.open !== thread) setCameFrom(threadIn);
  // The thread a place arrived naming, which its bundle looks for until it lists it.
  const [seekingThread, setSeekingThread] = useState(threadIn);
  if (seekingThread !== undefined && seekingThread.bundle !== bundle) {
    setSeekingThread(undefined);
  }
  const around = useAround(
    seekingThread?.open,
    inBundle.threads && inBundle.places,
    inBundle.isFetching,
    bundleQuery(bundle ?? NONE, { around: seekingThread?.open ?? '' }),
  );
  if (seekingThread !== undefined && around.isDone) setSeekingThread(undefined);
  // A place that arrives opens the thread it names, or none.
  const arriveAt = useCallback((place: Place) => {
    const named = threadNamedBy(place);
    setThreadIn(named);
    setSeekingThread(named);
  }, []);
  return {
    inBundle,
    /** The thread open, if one is. */
    thread,
    /** Where it lies among the bundle's threads, or -1. */
    threadAt,
    threadRow,
    /** Where the thread last open in the bundle lies, which the bundle shows in sight. */
    cameFromAt:
      cameFrom !== undefined && cameFrom.bundle === bundle
        ? inBundle.places.get(cameFrom.open)
        : undefined,
    /** Whether the bundle waits for the page that holds the thread a place arrived naming. */
    awaitsThread: around.awaits,
    setThreadIn,
    arriveAt,
  };
}

/** The thread a place names open in its bundle, if it names one. */
const threadNamedBy = ({ bundle, open }: Place): OpenThread | undefined =>
  bundle !== undefined && open !== undefined ? { bundle, open } : undefined;
