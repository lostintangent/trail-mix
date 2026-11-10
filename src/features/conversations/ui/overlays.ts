import { hashKey, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useSyncExternalStore } from 'react';
import type { ConversationSummary, View } from '../../mail/core/index.ts';
import { conversationsQuery } from '../../mailroom/client/index.ts';
import { isShown, overlaid, type Overlay } from '../core/triage.ts';

/**
 * How long an overlay whose command the Mailroom accepted waits for a snapshot to show it, before
 * giving way anyway, as when another device changed the conversation again.
 */
const SETTLED_MS = 10_000;

/** An overlay on one view's list, and once its command is accepted, when it gives way. */
export type Laid = { view: string; overlay: Overlay; expiry?: ReturnType<typeof setTimeout> };

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

  on(view: View): Overlay[] {
    return laidOn(this.#laid, view);
  }

  lay(view: View, overlay: Overlay): Laid {
    const laid: Laid = { view: keyOf(view), overlay };
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

  /** Lifts the overlays a fresh snapshot of a view's list already shows. */
  agreeWith(view: View, rows: readonly ConversationSummary[]) {
    const key = keyOf(view);
    const shown = this.#laid.filter((laid) => laid.view === key && isShown(rows, laid.overlay));
    for (const laid of shown) clearTimeout(laid.expiry);
    if (shown.length > 0) this.#set(this.#laid.filter((laid) => !shown.includes(laid)));
  }

  #set(laid: readonly Laid[]) {
    this.#laid = laid;
    for (const listener of this.#listeners) listener();
  }
}

const keyOf = (view: View) => hashKey(conversationsQuery(view).queryKey);

function laidOn(laid: readonly Laid[], view: View): Overlay[] {
  const key = keyOf(view);
  return laid.filter((each) => each.view === key).map(({ overlay }) => overlay);
}

const overlays = new WeakMap<QueryClient, Overlays>();

/** The overlays of the browser's lists, one set for each query client. */
export function overlaysOf(queryClient: QueryClient): Overlays {
  let found = overlays.get(queryClient);
  if (!found) overlays.set(queryClient, (found = new Overlays()));
  return found;
}

/**
 * A view's conversations as the member should see them: the Mailroom's snapshot with the triage
 * still on its way laid over it. Nothing until the snapshot's first page arrives.
 */
export function useTriagedList(
  view: View,
  rows: readonly ConversationSummary[] | undefined,
): readonly ConversationSummary[] | undefined {
  const laid = overlaysOf(useQueryClient());
  const all = useSyncExternalStore(laid.subscribe, laid.all);
  useEffect(() => {
    if (rows) laid.agreeWith(view, rows);
  }, [laid, view, rows]);
  return useMemo(() => rows && overlaid(rows, laidOn(all, view)), [rows, all, view]);
}
