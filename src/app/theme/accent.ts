import { deviceStorage } from '../../shared/deviceStorage.ts';

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
type SavedAccent = { color: string; css: string };

/** The picked accent as `#rrggbb`, or undefined for the default. */
export function readAccent(): string | undefined {
  return savedAccent()?.color;
}

/** The pick and the rule saved with it. */
function savedAccent(): SavedAccent | undefined {
  return parse(deviceStorage().getItem(ACCENT_STORAGE_KEY));
}

type AccentMath = typeof import('./readableAccent.ts');
let math: AccentMath | undefined;
const loadMath = async (): Promise<AccentMath> => (math ??= await import('./readableAccent.ts'));

/** Loads the math a pick needs, as soon as the member reaches for the picker. */
export const preloadAccentMath = () => void loadMath();

/**
 * Saves a pick, or the default when `color` is undefined or not `#rrggbb`. Going back to the
 * default needs no color math, and a pick once the math has loaded needs no wait, so either shows
 * in the same task.
 */
export async function saveAccent(color: string | undefined): Promise<void> {
  const css = color === undefined ? undefined : (math ?? (await loadMath())).accentRule(color);
  const saved = css && color ? { color: color.toLowerCase(), css } : undefined;
  if (saved) deviceStorage().setItem(ACCENT_STORAGE_KEY, JSON.stringify(saved));
  else deviceStorage().removeItem(ACCENT_STORAGE_KEY);
  // A remade rule shows at once, though the pick it was made from is the same.
  showAccent(saved?.color);
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

const listeners = new Set<() => void>();
