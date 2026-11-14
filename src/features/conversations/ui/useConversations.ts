import {
  hashKey,
  useQueries,
  useQuery,
  useQueryClient,
  type QueryClient,
  type QueryKey,
  type UseQueryOptions,
} from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { ConversationId, ListItem, View } from '../../mail/core/index.ts';
import { conversationsQuery, PAGE_SIZE, type Page } from '../../mailroom/client/index.ts';
import { listOf, pagesCovering, type Listed } from '../core/pages.ts';
import { unreadOnly } from '../core/triage.ts';
import { listKeyOf, useTriagedList, type ListOf } from './overlays.ts';

/**
 * How long the list rests on rows of pages it hasn't asked for before it asks, so a scrollbar's
 * thumb dragged down a long list asks only for where it stops, not for every page on the way.
 */
const SETTLE_MS = 100;

/** The pages a list starts with: its first, which also says how long it is. */
const FIRST_PAGE: readonly number[] = [0];

/**
 * A view's rows as the member should see them, at the list's true length from its first
 * page on, and how the list says which rows it shows, so the pages they lie on are fetched. While a
 * search is typed, its results so far stay until the next arrive, so the list doesn't blink between
 * keystrokes. A list of unread mail also holds the conversation `keep` names, read or not, until the
 * member leaves it.
 */
export function useConversations(
  view: View,
  {
    enabled,
    keep,
  }: {
    enabled: boolean;
    /** The conversation or bundle open in the list. */
    keep: ConversationId | undefined;
  },
): {
  conversations: Listed<ListItem> | undefined;
  /** Whether a page the list shows is on its way. */
  isFetching: boolean;
  /** Says which rows the list shows: from `first` to `last`, and the one at `selected`, if any. */
  show: Show;
} {
  const isUnread = 'unread' in view && view.unread === true;
  const kept = isUnread ? keep : undefined;
  const first = useQuery({
    ...conversationsQuery(view, 0, kept),
    enabled,
    placeholderData: (previous, previousQuery) =>
      view.in === 'search' && previousQuery?.queryKey[1].in === 'search' ? previous : undefined,
  });
  const placeholder = first.isPlaceholderData ? first.data : undefined;
  const placeheld = useMemo(
    () => placeholder && listOf([{ ...placeholder, fetchedAt: 0 }]),
    [placeholder],
  );
  const { rows, isFetching, show } = usePages(view, {
    pageAt: (at) => conversationsQuery(view, at, kept),
    isFirstFetching: first.isFetching,
    placeheld,
    enabled,
  });
  useKeptListed(view, kept, rows, isFetching);
  const triaged = useTriagedList(view, rows);
  const conversations = useMemo(
    () => (triaged && isUnread ? unreadOnly(triaged, kept) : triaged),
    [triaged, isUnread, kept],
  );
  return { conversations, isFetching, show };
}

/**
 * Asks again for a list of unread mail whose pages, fetched before a conversation was kept in it,
 * don't hold that conversation, as when it was read elsewhere and is opened from an address. Once
 * for each conversation kept, so one that has gone doesn't ask forever.
 */
function useKeptListed(
  view: View,
  kept: ConversationId | undefined,
  rows: Listed<ListItem> | undefined,
  isFetching: boolean,
) {
  const queryClient = useQueryClient();
  const asked = useRef<string>(undefined);
  useEffect(() => {
    if (!kept || !rows || isFetching || rows.some((row) => row?.id === kept)) return;
    const key = hashKey([listKeyOf(view), kept]);
    if (asked.current === key) return;
    asked.current = key;
    void queryClient.invalidateQueries({ queryKey: listKeyOf(view) });
  }, [queryClient, view, kept, rows, isFetching]);
}

/**
 * Says which rows a list shows: from `first` to `last`, and the one at `selected`, if any. Their
 * pages are fetched once the list rests on them, so a scroll asks only for where it stops, or at
 * once when they lie `ahead` of a step, as the threads beside the one open do, so a held key finds
 * the next page there before it reaches it.
 */
export type Show = (first: number, last: number, selected: number, ahead?: boolean) => void;

/**
 * A list's rows at its true length from its first page on: a view's, or a bundle's threads. Each
 * page is a snapshot of its own, kept by its place, so a hint refetches only the first page, which
 * says how long the list is, and the pages on screen. Pages fetched earlier, now out of sight, still
 * show where they lie, as a selected row scrolled far away does. The first page is the caller's to
 * ask for, since it carries what the list says of itself, and `show` asks for the rest.
 */
export function usePages<
  Fetched extends Page,
  Key extends readonly unknown[],
  Row extends ListItem = Fetched['items'][number],
>(
  list: ListOf,
  {
    pageAt,
    isFirstFetching,
    placeheld,
    enabled,
  }: {
    /** How to ask for the page that starts at a place. */
    pageAt: (at: number) => UseQueryOptions<Fetched, Error, Fetched, Key>;
    isFirstFetching: boolean;
    /** What shows while the first page is on its way, as a search's earlier results do. */
    placeheld?: Listed<Row> | undefined;
    enabled: boolean;
  },
): { rows: Listed<Row> | undefined; isFetching: boolean; show: Show } {
  const queryClient = useQueryClient();
  const key = hashKey(listKeyOf(list));
  const [wanted, setWanted] = useState({ key, pages: FIRST_PAGE });
  const pages = wanted.key === key ? wanted.pages : FIRST_PAGE;
  const isRestFetching = useQueries({
    queries: pages.flatMap((at) => (at === 0 ? [] : [{ ...pageAt(at), enabled }])),
    combine: (results) => results.some(({ isFetching }) => isFetching),
  });
  const fetched = useFetchedList<Row>(queryClient, list);
  // Pages on screen refetched for a hint land a moment apart, and mail that arrived between them
  // moves every row, so until all of them have landed, the list stays as it was. Then it moves once,
  // and the list can keep its top row in sight where it was.
  const isFetching = isFirstFetching || isRestFetching;
  const latest = placeheld ?? fetched;
  const shown = useRef<{ key: string; rows: Listed<Row> }>(undefined);
  const held = isFetching && latest && shown.current?.key === key ? shown.current.rows : undefined;
  const rows = held ?? latest;
  useEffect(() => {
    if (rows) shown.current = { key, rows };
  });

  // The list says which rows it shows as it scrolls, and once it rests, its new pages are fetched.
  const total = rows?.length ?? 0;
  const settling = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(settling.current), []);
  const show = useCallback<Show>(
    (from, to, selected, ahead = false) => {
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
      const want = () => setWanted({ key, pages: next });
      if (ahead) want();
      else settling.current = setTimeout(want, SETTLE_MS);
    },
    [key, total, pages],
  );
  return { rows, isFetching, show };
}

/**
 * Asks for the page of a list around a row it hasn't listed, and says whether the list waits for
 * it: while the page is on its way, and once it holds the row, until the list has caught up with
 * it. The looking is done once the list lists the row, or has caught up without it, or asking for
 * the page failed. Offline it waits for nothing and asks again once it can.
 */
export function useAround<Fetched extends Page, Key extends QueryKey>(
  row: ConversationId | undefined,
  places: ReadonlyMap<string, number> | undefined,
  isFetching: boolean,
  query: UseQueryOptions<Fetched, Error, Fetched, Key>,
): { awaits: boolean; isDone: boolean } {
  const isAsked = row !== undefined && places !== undefined && !places.has(row);
  const around = useQuery({ ...query, enabled: isAsked });
  const awaits =
    isAsked &&
    (around.isLoading || (isFetching && around.data?.items.some(({ id }) => id === row) === true));
  const isDone =
    row !== undefined && places !== undefined && (!isAsked || (around.isFetched && !awaits));
  return { awaits, isDone };
}

/**
 * A list as the pages of it the browser holds show it, fetched lately or a while ago. Only the
 * list's own pages count, not those of a view whose key holds more, as a full-text search's does a
 * plain one's.
 */
export function fetchedList<Row extends ListItem = ListItem>(
  queryClient: QueryClient,
  list: ListOf,
): Listed<Row> | undefined {
  const key = hashKey(listKeyOf(list));
  return listOf(
    queryClient
      .getQueryCache()
      .findAll({ queryKey: listKeyOf(list) })
      .flatMap(({ queryKey, state: { data, dataUpdatedAt } }) =>
        data && listOfKey(queryKey) === key
          ? [{ ...(data as Page<Row>), fetchedAt: dataUpdatedAt }]
          : [],
      ),
  );
}

/**
 * Some conversations' rows among the pages of a list the browser holds, each as the freshest page
 * holding it shows it, found without laying out the whole list.
 */
export function fetchedRows(
  queryClient: QueryClient,
  list: ListOf,
  ids: readonly ConversationId[],
): ListItem[] {
  const key = hashKey(listKeyOf(list));
  const wanted = new Set(ids);
  const found = new Map<ConversationId, { row: ListItem; fetchedAt: number }>();
  for (const { queryKey, state } of queryClient
    .getQueryCache()
    .findAll({ queryKey: listKeyOf(list) })) {
    if (!state.data || listOfKey(queryKey) !== key) continue;
    for (const row of (state.data as Page).items) {
      const seen = found.get(row.id);
      if (wanted.has(row.id) && (!seen || seen.fetchedAt < state.dataUpdatedAt)) {
        found.set(row.id, { row, fetchedAt: state.dataUpdatedAt });
      }
    }
  }
  return [...found.values()].map(({ row }) => row);
}

/** A list as `fetchedList` makes it, made anew as a page of it arrives or leaves the cache. */
function useFetchedList<Row extends ListItem>(
  queryClient: QueryClient,
  list: ListOf,
): Listed<Row> | undefined {
  const key = hashKey(listKeyOf(list));
  const made = useRef<{ key: string; rows: Listed<Row> | undefined }>(undefined);
  const subscribe = useCallback(
    (changed: () => void) =>
      queryClient.getQueryCache().subscribe((event) => {
        const isChange =
          event.type === 'removed' || (event.type === 'updated' && event.action.type === 'success');
        if (!isChange || listOfKey(event.query.queryKey as readonly unknown[]) !== key) return;
        made.current = undefined;
        changed();
      }),
    [queryClient, key],
  );
  return useSyncExternalStore(subscribe, () => {
    if (made.current?.key !== key)
      made.current = { key, rows: fetchedList<Row>(queryClient, list) };
    return made.current.rows;
  });
}

/** The list a page's key names, as `listKeyOf` hashes it, or nothing for another key. */
const listOfKey = (queryKey: readonly unknown[]) =>
  queryKey[0] === 'conversations' || queryKey[0] === 'bundle'
    ? hashKey(queryKey.slice(0, 2))
    : undefined;
