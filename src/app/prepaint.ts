import { PANELS, panelSize, readPanel, type PanelSpec } from '../features/workbench/index.ts';
import { ACCENT_STORAGE_KEY, ACCENT_STYLE_ID } from './theme/accent.ts';
import { THEME_STORAGE_KEY } from './theme/mode.ts';

type Prepaint = {
  themeKey: string;
  accent: { key: string; styleId: string };
  panels: PanelSpec[];
};

/**
 * Runs inline in the document head, before first paint and before the app starts: it applies the
 * saved theme mode, the accent's saved rule and the side panels' sizes, so the workbench appears as
 * it was left.
 *
 * The shell inlines this function's source, and the two it is handed, so each must stay
 * self-contained. They may use their parameters and browser globals, and nothing imported or
 * declared outside them.
 */
function prepaint(
  { themeKey, accent, panels }: Prepaint,
  read: typeof readPanel,
  size: typeof panelSize,
): void {
  const root = document.documentElement;
  let storage: Pick<Storage, 'getItem'> = { getItem: () => null };
  try {
    storage = localStorage;
    const mode = storage.getItem(themeKey);
    if (mode === 'light' || mode === 'dark') root.dataset['theme'] = mode;
  } catch {
    // Without storage the system picks the theme, and the panels take their defaults.
  }
  try {
    const { css } = JSON.parse(storage.getItem(accent.key) ?? '{}') as { css?: unknown };
    if (typeof css === 'string') {
      const style = document.createElement('style');
      style.id = accent.styleId;
      style.textContent = css;
      document.head.append(style);
    }
  } catch {
    // An accent it can't read leaves the default until the app runs, which saves the pick again.
  }
  for (const panel of panels) {
    root.style.setProperty(panel.variable, `${size(panel, read(panel, storage))}px`);
  }
}

const config: Prepaint = {
  themeKey: THEME_STORAGE_KEY,
  accent: { key: ACCENT_STORAGE_KEY, styleId: ACCENT_STYLE_ID },
  panels: Object.values(PANELS),
};

/** The inline script the document shell carries. */
export const prepaintScript = `(${prepaint.toString()})(${JSON.stringify(config)}, ${readPanel.toString()}, ${panelSize.toString()})`;
