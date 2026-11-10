import { useSyncExternalStore } from 'react';

/**
 * The send this device can still take back, offered by the toast counting it down, so Undo in the
 * registry and its key reach it. The latest send offered wins.
 */
export type Undoable = { id: string; takeBack: () => void };

let current: Undoable | undefined;
const listeners = new Set<() => void>();

export function offerUndo(undoable: Undoable) {
  current = undoable;
  for (const listener of listeners) listener();
}

export function withdrawUndo(id: string) {
  if (current?.id !== id) return;
  current = undefined;
  for (const listener of listeners) listener();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export const useUndoable = () => useSyncExternalStore(subscribe, () => current);
