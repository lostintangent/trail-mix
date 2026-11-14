import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import type { BundleId, BundleSummary, ConversationSummary } from '../../mail/core/index.ts';
import { bundleQuery } from '../../mailroom/client/index.ts';
import { placesOf, type Listed } from '../core/pages.ts';
import { useTriagedList } from './overlays.ts';
import { usePages, type Show } from './useConversations.ts';

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
