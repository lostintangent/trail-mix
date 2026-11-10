import { THEME_STORAGE_KEY } from './theme/mode.ts';

/**
 * Runs inline in the document head, before first paint and before the app starts: it applies the
 * saved theme mode, so the desk is painted in the right colors from the start.
 *
 * The shell inlines this function's source, so it must stay self-contained. It may use its
 * parameters and browser globals, and nothing imported or declared outside it.
 */
function prepaint(themeStorageKey: string): void {
  try {
    const mode = localStorage.getItem(themeStorageKey);
    if (mode === 'light' || mode === 'dark') document.documentElement.dataset['theme'] = mode;
  } catch {
    // Without storage the system decides.
  }
}

/** The inline script the document shell carries. */
export const prepaintScript = `(${prepaint.toString()})(${JSON.stringify(THEME_STORAGE_KEY)})`;
