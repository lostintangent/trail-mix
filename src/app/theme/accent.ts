import { parseHex } from '../../shared/color.ts';
import { accentRule } from './readableAccent.ts';

/**
 * The accent this device shows: ink blue by default, or a color the member picked, saved here.
 *
 * A pick is saved with the style rule it makes, which `prepaint.ts` puts on the page before first
 * paint without doing any color math, and `useAccent` keeps on the page after that. The rule is
 * remade from the pick each time the app starts, so a saved copy is never stale for longer than
 * one load.
 */

export const ACCENT_STORAGE_KEY = 'trail-mix.accent';

/** The style element that carries a picked accent's rule. */
export const ACCENT_STYLE_ID = 'trail-mix-accent';

/** What a device keeps for a picked accent. */
export type SavedAccent = { color: string; css: string };

/** The picked accent as `#rrggbb`, or undefined for the default. */
export function readAccent(): string | undefined {
  try {
    return parse(localStorage.getItem(ACCENT_STORAGE_KEY))?.color;
  } catch {
    // Without storage, as in some private windows, a pick lasts until the page reloads.
    return unsaved;
  }
}

/** Saves a pick, or the default when `color` is undefined or not `#rrggbb`. */
export function saveAccent(color: string | undefined): void {
  const css = color === undefined ? undefined : accentRule(color);
  unsaved = css ? color?.toLowerCase() : undefined;
  try {
    if (css) localStorage.setItem(ACCENT_STORAGE_KEY, JSON.stringify({ color: unsaved, css }));
    else localStorage.removeItem(ACCENT_STORAGE_KEY);
  } catch {
    // `unsaved` holds it instead.
  }
  for (const listener of listeners) listener();
}

/** Calls `onChange` when this page or another tab on this device saves a pick. */
export function subscribeToAccent(onChange: () => void): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key === ACCENT_STORAGE_KEY || event.key === null) onChange();
  };
  listeners.add(onChange);
  addEventListener('storage', onStorage);
  return () => {
    listeners.delete(onChange);
    removeEventListener('storage', onStorage);
  };
}

/** Puts the accent's rule on the page, or takes it off for the default. */
export function showAccent(color: string | undefined): void {
  const css = color === undefined ? undefined : accentRule(color);
  let style = document.getElementById(ACCENT_STYLE_ID);
  if (!css) {
    style?.remove();
    return;
  }
  if (!style) {
    style = document.createElement('style');
    style.id = ACCENT_STYLE_ID;
    document.head.append(style);
  }
  if (style.textContent !== css) style.textContent = css;
}

function parse(saved: string | null): SavedAccent | undefined {
  try {
    const value: unknown = JSON.parse(saved ?? 'null');
    if (typeof value !== 'object' || value === null) return undefined;
    const { color, css } = value as Partial<Record<keyof SavedAccent, unknown>>;
    return typeof color === 'string' && typeof css === 'string' && parseHex(color)
      ? { color, css }
      : undefined;
  } catch {
    return undefined;
  }
}

let unsaved: string | undefined;
const listeners = new Set<() => void>();
