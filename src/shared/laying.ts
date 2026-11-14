import type { QueryClient } from '@tanstack/react-query';
import { listeners } from './listeners.ts';

/**
 * How long an accepted change waits for a snapshot to show it, before giving way anyway, as when
 * another device changed the same thing again.
 */
const SETTLED_MS = 10_000;

/** A change laid over a snapshot, and once its command is accepted, when it gives way. */
export type Laid<T> = { change: T; expiry?: ReturnType<typeof setTimeout> };

/**
 * The changes a browser lays over a snapshot while their commands are carried out. Each stays until
 * a fresh snapshot shows it, so one fetched before the change was accepted can't undo it on screen.
 * A refused change is lifted at once, which is how what it changed returns.
 */
export class Laying<T> {
  #laid: readonly Laid<T>[] = [];
  readonly #listeners = listeners();

  subscribe = this.#listeners.subscribe;

  all = () => this.#laid;

  lay(change: T): Laid<T> {
    const laid = { change };
    this.#set([...this.#laid, laid]);
    return laid;
  }

  lift(laid: Laid<T>) {
    clearTimeout(laid.expiry);
    this.#set(this.#laid.filter((each) => each !== laid));
  }

  /** The command was accepted, so the change now only waits for a snapshot to show it. */
  settle(laid: Laid<T>) {
    laid.expiry = setTimeout(() => this.lift(laid), SETTLED_MS);
  }

  /** Lifts the changes a fresh snapshot already shows. */
  agreeWith(isShown: (change: T) => boolean) {
    const shown = this.#laid.filter(({ change }) => isShown(change));
    for (const laid of shown) clearTimeout(laid.expiry);
    if (shown.length > 0) this.#set(this.#laid.filter((laid) => !shown.includes(laid)));
  }

  #set(laid: readonly Laid<T>[]) {
    this.#laid = laid;
    this.#listeners.tell();
  }
}

/** One Laying for each query client, since a browser's snapshots are its query client's. */
export function layingsOf<T>(): (queryClient: QueryClient) => Laying<T> {
  const layings = new WeakMap<QueryClient, Laying<T>>();
  return (queryClient) => {
    let found = layings.get(queryClient);
    if (!found) layings.set(queryClient, (found = new Laying()));
    return found;
  };
}
