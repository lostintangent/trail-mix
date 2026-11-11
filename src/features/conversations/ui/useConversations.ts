import {
  hashKey,
  useQueries,
  useQuery,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { ConversationId, ConversationSummary, View } from '../../mail/core/index.ts';
import { conversationsQuery, keys, PAGE_SIZE, type Page } from '../../mailroom/client/index.ts';
import { listOf, pagesCovering, type Listed } from '../core/pages.ts';
import { useTriagedList } from './overlays.ts';

/**
 * How long the list rests on rows of pages it hasn't asked for before it asks, so a scrollbar's
 * thumb dragged down a long list asks only for where it stops, not for every page on the way.
 */
const SETTLE_MS = 100;

/** The pages a list starts with: its first, which also says how long it is. */
const FIRST_PAGE: readonly number[] = [0];

/**
 * A view's conversations as the member should see them, at the list's true length from its first
 * page on, and how the list says which rows it shows, so the pages they lie on are fetched. Each
 * page is a snapshot of its own, kept by its place, so a hint refetches only the first page, which
 * says how long the list is, and the pages on screen. Pages fetched earlier, now out of sight, still
 * show where they lie, as a selected row scrolled far away does. While a search is typed, its
 * results so far stay until the next arrive, so the list doesn't blink between keystrokes.
 */
export function useConversations(
  view: View,
  { enabled = true }: { enabled?: boolean } = {},
): {
  conversations: Listed<ConversationSummary> | undefined;
  /** Whether a page the list shows is on its way. */
  isFetching: boolean;
  /** Says which rows the list shows: from `first` to `last`, and the one at `selected`, if any. */
  show: (first: number, last: number, selected: number) => void;
} {
  const queryClient = useQueryClient();
  const list = hashKey(keys.conversations(view));
  const first = useQuery({
    ...conversationsQuery(view),
    enabled,
    placeholderData: (previous, previousQuery) =>
      view.in === 'search' && previousQuery?.queryKey[1].in === 'search' ? previous : undefined,
  });
  const [wanted, setWanted] = useState({ list, pages: FIRST_PAGE });
  const pages = wanted.list === list ? wanted.pages : FIRST_PAGE;
  const rest = useQueries({
    queries: pages.flatMap((at) =>
      at === 0 ? [] : [{ ...conversationsQuery(view, at), enabled }],
    ),
  });
  const fetched = useFetchedList(queryClient, view);
  const placeholder = first.isPlaceholderData ? first.data : undefined;
  const placeheld = useMemo(
    () => placeholder && listOf([{ ...placeholder, fetchedAt: 0 }]),
    [placeholder],
  );
  // Pages on screen refetched for a hint land a moment apart, and mail that arrived between them
  // moves every row, so until all of them have landed, the list stays as it was. Then it moves once,
  // and the list can keep its top row in sight where it was.
  const isFetching = first.isFetching || rest.some(({ isFetching }) => isFetching);
  const latest = placeheld ?? fetched;
  const shown = useRef<{ list: string; rows: Listed<ConversationSummary> }>(undefined);
  const held =
    isFetching && latest && shown.current?.list === list ? shown.current.rows : undefined;
  const rows = held ?? latest;
  useEffect(() => {
    if (rows) shown.current = { list, rows };
  });

  // The list says which rows it shows as it scrolls, and once it rests, its new pages are fetched.
  const total = rows?.length ?? 0;
  const settling = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(settling.current), []);
  const show = useCallback(
    (from: number, to: number, selected: number) => {
      const next = pagesCovering(
        [
          [from, to],
          [selected, selected],
        ],
        total,
        PAGE_SIZE,
      );
      clearTimeout(settling.current);
      if (next.length === pages.length && next.every((at, index) => at === pages[index])) return;
      settling.current = setTimeout(() => setWanted({ list, pages: next }), SETTLE_MS);
    },
    [list, total, pages],
  );

  return {
    conversations: useTriagedList(view, rows),
    isFetching,
    show,
  };
}

/**
 * A view's list as the pages of it the browser holds show it, fetched lately or a while ago. Only
 * the view's own pages count, not those of a view whose key holds more, as a full-text search's
 * does a plain one's.
 */
export function fetchedList(
  queryClient: QueryClient,
  view: View,
): Listed<ConversationSummary> | undefined {
  const list = hashKey(keys.conversations(view));
  return listOf(
    queryClient
      .getQueryCache()
      .findAll({ queryKey: keys.conversations(view) })
      .flatMap(({ queryKey, state: { data, dataUpdatedAt } }) =>
        data && listOfKey(queryKey) === list
          ? [{ ...(data as Page), fetchedAt: dataUpdatedAt }]
          : [],
      ),
  );
}

/**
 * Some conversations' rows among the pages of a view the browser holds, each as the freshest page
 * holding it shows it, found without laying out the whole list.
 */
export function fetchedRows(
  queryClient: QueryClient,
  view: View,
  ids: readonly ConversationId[],
): ConversationSummary[] {
  const list = hashKey(keys.conversations(view));
  const wanted = new Set(ids);
  const found = new Map<ConversationId, { row: ConversationSummary; fetchedAt: number }>();
  for (const { queryKey, state } of queryClient
    .getQueryCache()
    .findAll({ queryKey: keys.conversations(view) })) {
    if (!state.data || listOfKey(queryKey) !== list) continue;
    for (const row of (state.data as Page).items) {
      const seen = found.get(row.id);
      if (wanted.has(row.id) && (!seen || seen.fetchedAt < state.dataUpdatedAt)) {
        found.set(row.id, { row, fetchedAt: state.dataUpdatedAt });
      }
    }
  }
  return [...found.values()].map(({ row }) => row);
}

/** A view's list as `fetchedList` makes it, made anew as a page of it arrives or leaves the cache. */
function useFetchedList(
  queryClient: QueryClient,
  view: View,
): Listed<ConversationSummary> | undefined {
  const list = hashKey(keys.conversations(view));
  const made = useRef<{ list: string; rows: Listed<ConversationSummary> | undefined }>(undefined);
  const subscribe = useCallback(
    (changed: () => void) =>
      queryClient.getQueryCache().subscribe((event) => {
        const isChange =
          event.type === 'removed' || (event.type === 'updated' && event.action.type === 'success');
        if (!isChange || listOfKey(event.query.queryKey as readonly unknown[]) !== list) return;
        made.current = undefined;
        changed();
      }),
    [queryClient, list],
  );
  return useSyncExternalStore(subscribe, () => {
    if (made.current?.list !== list) made.current = { list, rows: fetchedList(queryClient, view) };
    return made.current.rows;
  });
}

/** The list a page's key names, as `keys.conversations` hashes it, or nothing for another key. */
const listOfKey = (queryKey: readonly unknown[]) =>
  queryKey[0] === 'conversations' ? hashKey(queryKey.slice(0, 2)) : undefined;
