import { useLayoutEffect, useState } from 'react';
import { panelSize, readPanel, savePanel, type PanelSpec, type PanelState } from './panels.ts';

/**
 * A side panel's state on this device, kept in storage and on its custom property on `<html>`,
 * where the prepaint script put it before first paint.
 */
export function usePanel(spec: PanelSpec): [PanelState, (state: PanelState) => void] {
  const [state, setState] = useState(() => readPanel(spec, deviceStorage()));

  useLayoutEffect(() => {
    document.documentElement.style.setProperty(spec.variable, `${panelSize(spec, state)}px`);
  }, [spec, state]);

  const change = (next: PanelState) => {
    setState(next);
    savePanel(spec, next, deviceStorage());
  };
  return [state, change];
}

/** This device's storage, or one that forgets on reload where storage is blocked. */
function deviceStorage(): Storage {
  try {
    return localStorage;
  } catch {
    return forgetful;
  }
}

const memory = new Map<string, string>();
const forgetful: Storage = {
  get length() {
    return memory.size;
  },
  clear: () => memory.clear(),
  getItem: (key) => memory.get(key) ?? null,
  key: (index) => [...memory.keys()][index] ?? null,
  removeItem: (key) => memory.delete(key),
  setItem: (key, value) => memory.set(key, value),
};
