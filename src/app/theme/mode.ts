/**
 * The color mode this device shows: the system's by default, or a Light or Dark choice saved here.
 *
 * `<html>` carries the choice as `data-theme`, which Astryx maps to `color-scheme`, so every
 * `light-dark()` token follows it. No attribute means the system decides. `prepaint.ts` applies
 * the saved choice before first paint, and Astryx's `Theme` keeps it applied after that.
 */

export type ThemeMode = 'system' | 'light' | 'dark';

export const THEME_STORAGE_KEY = 'trail-mix.theme';

export function readThemeMode(): ThemeMode {
  try {
    return parse(localStorage.getItem(THEME_STORAGE_KEY));
  } catch {
    // Without storage, as in some private windows, a choice lasts until the page reloads.
    return unsaved;
  }
}

export function saveThemeMode(mode: ThemeMode): void {
  unsaved = mode;
  try {
    if (mode === 'system') localStorage.removeItem(THEME_STORAGE_KEY);
    else localStorage.setItem(THEME_STORAGE_KEY, mode);
  } catch {
    // `unsaved` holds it instead.
  }
  for (const listener of listeners) listener();
}

/** Calls `onChange` when this page or another tab on this device saves a choice. */
export function subscribeToThemeMode(onChange: () => void): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key === THEME_STORAGE_KEY || event.key === null) onChange();
  };
  listeners.add(onChange);
  addEventListener('storage', onStorage);
  return () => {
    listeners.delete(onChange);
    removeEventListener('storage', onStorage);
  };
}

export function parse(saved: string | null): ThemeMode {
  return saved === 'light' || saved === 'dark' ? saved : 'system';
}

let unsaved: ThemeMode = 'system';
const listeners = new Set<() => void>();
