/**
 * The accent this device shows: ink blue by default, or a color the member picked, saved here.
 *
 * A pick is saved with the style rule it makes, which `prepaint.ts` puts on the page before first
 * paint without doing any color math, and `useAccent` keeps on the page after that. Only saving a
 * pick does the math, which loads apart from the first screen. The rule is remade from the pick
 * once each time the app starts, while the browser is idle, so a saved copy is never stale for
 * longer than one load.
 */

export const ACCENT_STORAGE_KEY = 'trail-mix.accent';

/** The style element that carries a picked accent's rule. */
export const ACCENT_STYLE_ID = 'trail-mix-accent';

/** What a device keeps for a picked accent. */
export type SavedAccent = { color: string; css: string };

/** The picked accent as `#rrggbb`, or undefined for the default. */
export function readAccent(): string | undefined {
  return savedAccent()?.color;
}

/** The pick and the rule saved with it. */
function savedAccent(): SavedAccent | undefined {
  try {
    return parse(localStorage.getItem(ACCENT_STORAGE_KEY));
  } catch {
    // Without storage, as in some private windows, a pick lasts until the page reloads.
    return unsaved;
  }
}

/**
 * Saves a pick, or the default when `color` is undefined or not `#rrggbb`. Going back to the
 * default needs no color math, so it shows in the same task.
 */
export async function saveAccent(color: string | undefined): Promise<void> {
  const css =
    color === undefined ? undefined : (await import('./readableAccent.ts')).accentRule(color);
  unsaved = css && color ? { color: color.toLowerCase(), css } : undefined;
  try {
    if (unsaved) localStorage.setItem(ACCENT_STORAGE_KEY, JSON.stringify(unsaved));
    else localStorage.removeItem(ACCENT_STORAGE_KEY);
  } catch {
    // `unsaved` holds it instead.
  }
  // A remade rule shows at once, though the pick it was made from is the same.
  showAccent(unsaved?.color);
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

/** Puts the rule saved with the accent on the page, or takes it off for the default. */
export function showAccent(color: string | undefined): void {
  const css = color === undefined ? undefined : savedAccent()?.css;
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
    return typeof color === 'string' && typeof css === 'string' && HEX.test(color)
      ? { color, css }
      : undefined;
  } catch {
    return undefined;
  }
}

/** A color as `#rrggbb`, the only way a pick is saved. */
const HEX = /^#[0-9a-f]{6}$/i;

let unsaved: SavedAccent | undefined;
const listeners = new Set<() => void>();
