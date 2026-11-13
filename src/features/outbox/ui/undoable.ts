import { useSyncExternalStore } from 'react';

/**
 * The send this device can still take back, offered by whatever counts it down on screen, its line
 * in its conversation or its toast, so Undo in the registry and its key reach it. The latest send
 * offered wins, and withdrawing an offer leaves every other standing.
 */
export type Undoable = { id: string; takeBack: () => void };

let offers: readonly Undoable[] = [];
const listeners = new Set<() => void>();

/** Offers a send to Undo, until the returned function withdraws this offer alone. */
export function offerUndo(undoable: Undoable): () => void {
  offers = [...offers, undoable];
  tell();
  return () => {
    offers = offers.filter((offer) => offer !== undoable);
    tell();
  };
}

function tell() {
  for (const listener of listeners) listener();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

const latest = () => offers.at(-1);

export const useUndoable = () => useSyncExternalStore(subscribe, latest);
