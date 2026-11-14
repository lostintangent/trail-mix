import { hashKey, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { layingsOf, type Laid, type Laying } from '../../../shared/laying.ts';
import type { BundleId, ListItem, View } from '../../mail/core/index.ts';
import { keys } from '../../mailroom/client/index.ts';
import type { Listed } from '../core/pages.ts';
import { isShown, overlaid, type Overlay } from '../core/triage.ts';

/** A list the browser shows: a view's, or a bundle's threads. */
export type ListOf = View | BundleId;

/** The key a list's pages are kept under. */
export const listKeyOf = (list: ListOf) =>
  typeof list === 'string' ? keys.bundle(list) : keys.conversations(list);

const keyOf = (list: ListOf) => hashKey(listKeyOf(list));

/** An overlay on one list, which the browser lays while triage reaches the mail server. */
export type OnList = { list: string; overlay: Overlay };

export type Overlays = Laying<OnList>;

/** The overlays of the browser's lists, one set for each query client. */
export const overlaysOf = layingsOf<OnList>();

/** An overlay to lay on a list. */
export const onList = (list: ListOf, overlay: Overlay): OnList => ({ list: keyOf(list), overlay });

/** The overlays laid on a list. */
export function laidOn(laid: readonly Laid<OnList>[], list: ListOf): Overlay[] {
  const key = keyOf(list);
  return laid.filter(({ change }) => change.list === key).map(({ change }) => change.overlay);
}

/**
 * A list's rows as the member should see them: the Mailroom's snapshot with the triage still on its
 * way laid over it. Nothing until the snapshot's first page arrives. A bundle's list holds its
 * conversations alone, and so do the overlays laid on it.
 */
export function useTriagedList<Row extends ListItem>(
  list: ListOf,
  rows: Listed<Row> | undefined,
): Listed<Row> | undefined {
  const laid = overlaysOf(useQueryClient());
  const all = useSyncExternalStore(laid.subscribe, laid.all);
  useEffect(() => {
    const key = keyOf(list);
    if (rows) laid.agreeWith((change) => change.list === key && isShown(rows, change.overlay));
  }, [laid, list, rows]);
  return useMemo(
    () => rows && overlaid(rows, laidOn(all, list) as Overlay<Row>[]),
    [rows, all, list],
  );
}
