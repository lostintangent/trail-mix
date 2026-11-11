import { PANELS, panelSize, readPanel, type PanelSpec } from '../features/workbench/index.ts';
import { ACCENT_STORAGE_KEY, ACCENT_STYLE_ID } from './theme/accent.ts';

type Prepaint = {
  accent: { key: string; styleId: string };
  panels: PanelSpec[];
};

/**
 * Runs inline in the document head, before first paint and before the app starts: it applies the
 * accent's saved rule and the side panels' sizes, so the workbench appears as it was left. The
 * theme is the system's, which the shell's `color-scheme` already shows.
 *
 * The shell inlines this function's source, and the two it is handed, so each must stay
 * self-contained. They may use their parameters and browser globals, and nothing imported or
 * declared outside them.
 */
function prepaint(
  { accent, panels }: Prepaint,
  read: typeof readPanel,
  size: typeof panelSize,
): void {
  const root = document.documentElement;
  let storage: Pick<Storage, 'getItem'> = { getItem: () => null };
  try {
    storage = localStorage;
  } catch {
    // Without storage the panels take their defaults.
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
  accent: { key: ACCENT_STORAGE_KEY, styleId: ACCENT_STYLE_ID },
  panels: Object.values(PANELS),
};

/** The inline script the document shell carries. */
export const prepaintScript = `(${prepaint.toString()})(${JSON.stringify(config)}, ${readPanel.toString()}, ${panelSize.toString()})`;
