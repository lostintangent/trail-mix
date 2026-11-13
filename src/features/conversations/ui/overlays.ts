import { hashKey, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useSyncExternalStore } from 'react';
import type { BundleId, ListItem, View } from '../../mail/core/index.ts';
import { keys } from '../../mailroom/client/index.ts';
import type { Listed } from '../core/pages.ts';
import { isShown, overlaid, type Overlay } from '../core/triage.ts';

/**
 * How long an overlay whose command the Mailroom accepted waits for a snapshot to show it, before
 * giving way anyway, as when another device changed the conversation again.
 */
const SETTLED_MS = 10_000;

/** A list the browser shows: a view's, or a bundle's threads. */
export type ListOf = View | BundleId;

/** The key a list's pages are kept under. */
export const listKeyOf = (list: ListOf) =>
  typeof list === 'string' ? keys.bundle(list) : keys.conversations(list);

/** An overlay on one list, and once its command is accepted, when it gives way. */
export type Laid = { list: string; overlay: Overlay; expiry?: ReturnType<typeof setTimeout> };

/**
 * The overlays a browser lays over its lists while triage reaches the mail server. Each stays until
 * a snapshot of its list already shows it, so a snapshot fetched before the Mailroom folded the
 * change can't put a conversation back on screen. A refused command's overlay is lifted at once,
 * which is how its conversation returns.
 */
export class Overlays {
  #laid: readonly Laid[] = [];
  readonly #listeners = new Set<() => void>();

  subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    return () => void this.#listeners.delete(listener);
  };

  all = () => this.#laid;

  on(list: ListOf): Overlay[] {
    return laidOn(this.#laid, list);
  }

  lay(list: ListOf, overlay: Overlay): Laid {
    const laid: Laid = { list: keyOf(list), overlay };
    this.#set([...this.#laid, laid]);
    return laid;
  }

  lift(laid: Laid) {
    clearTimeout(laid.expiry);
    this.#set(this.#laid.filter((each) => each !== laid));
  }

  /** The Mailroom accepted the command, so the overlay now only waits for a snapshot to agree. */
  settle(laid: Laid) {
    laid.expiry = setTimeout(() => this.lift(laid), SETTLED_MS);
  }

  /** Lifts the overlays a fresh snapshot of a list already shows. */
  agreeWith(list: ListOf, rows: Listed<ListItem>) {
    const key = keyOf(list);
    const shown = this.#laid.filter((laid) => laid.list === key && isShown(rows, laid.overlay));
    for (const laid of shown) clearTimeout(laid.expiry);
    if (shown.length > 0) this.#set(this.#laid.filter((laid) => !shown.includes(laid)));
  }

  #set(laid: readonly Laid[]) {
    this.#laid = laid;
    for (const listener of this.#listeners) listener();
  }
}

const keyOf = (list: ListOf) => hashKey(listKeyOf(list));

function laidOn(laid: readonly Laid[], list: ListOf): Overlay[] {
  const key = keyOf(list);
  return laid.filter((each) => each.list === key).map(({ overlay }) => overlay);
}

const overlays = new WeakMap<QueryClient, Overlays>();

/** The overlays of the browser's lists, one set for each query client. */
export function overlaysOf(queryClient: QueryClient): Overlays {
  let found = overlays.get(queryClient);
  if (!found) overlays.set(queryClient, (found = new Overlays()));
  return found;
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
    if (rows) laid.agreeWith(list, rows);
  }, [laid, list, rows]);
  return useMemo(
    () => rows && overlaid(rows, laidOn(all, list) as Overlay<Row>[]),
    [rows, all, list],
  );
}
