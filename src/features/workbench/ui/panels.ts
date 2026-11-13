/**
 * The side panels' geometry and how a device remembers it: pixel widths, the range a drag may
 * choose, and the rail each collapses to.
 *
 * Both the prepaint script and the workbench read a panel through `readPanel`, which the shell
 * inlines before first paint. It must stay self-contained: its parameters and browser globals
 * only, nothing imported or declared outside it.
 */

export type PanelName = 'sidebar' | 'list';

export type PanelSpec = {
  /** The localStorage key the panel's state is saved under. */
  key: string;
  /** The custom property on `<html>` that the layout reads the panel's current size from. */
  variable: string;
  /** The width a device starts with, and the range a drag or a key may choose. */
  width: number;
  min: number;
  max: number;
  /** The width the panel collapses to, its rail. */
  rail: number;
};

export type PanelState = { width: number; isCollapsed: boolean };

export const PANELS: Record<PanelName, PanelSpec> = {
  sidebar: {
    key: 'trail-mix.panel.sidebar',
    variable: '--workbench-sidebar',
    width: 240,
    min: 200,
    max: 360,
    // The rail a mouse folds it to, tm.sidebarRail's, which a finger's targets widen.
    rail: 40,
  },
  list: {
    key: 'trail-mix.panel.list',
    variable: '--workbench-list',
    width: 380,
    min: 300,
    max: 560,
    rail: 52,
  },
};

/** How far one arrow key moves a panel's edge. */
export const KEYBOARD_STEP = 16;

/** A panel's saved state, or its defaults when nothing valid is saved or storage is blocked. */
export function readPanel(spec: PanelSpec, storage: Pick<Storage, 'getItem'>): PanelState {
  try {
    const saved: unknown = JSON.parse(storage.getItem(spec.key) ?? 'null');
    if (typeof saved === 'object' && saved !== null && 'width' in saved && 'isCollapsed' in saved) {
      const { width, isCollapsed } = saved;
      if (typeof width === 'number' && Number.isFinite(width) && typeof isCollapsed === 'boolean') {
        return { width: Math.min(spec.max, Math.max(spec.min, Math.round(width))), isCollapsed };
      }
    }
  } catch {
    // Blocked or malformed storage falls through to the defaults.
  }
  return { width: spec.width, isCollapsed: false };
}

export function savePanel(spec: PanelSpec, state: PanelState, storage: Storage): void {
  try {
    storage.setItem(spec.key, JSON.stringify(state));
  } catch {
    // The panel keeps its state until the page reloads.
  }
}

/** The width the panel takes up now: its rail when collapsed. */
export function panelSize(spec: PanelSpec, state: PanelState): number {
  return state.isCollapsed ? spec.rail : state.width;
}

/**
 * Where a drag of the panel's edge to `edge` pixels leaves it. Below the midpoint between the rail
 * and the narrowest width, the drag asks to collapse, and the panel keeps the width it expands back
 * to. Anything wider is a width, within the panel's range.
 */
export function dragPanel(spec: PanelSpec, state: PanelState, edge: number): PanelState {
  if (edge < (spec.rail + spec.min) / 2) return { width: state.width, isCollapsed: true };
  return { width: Math.min(spec.max, Math.max(spec.min, Math.round(edge))), isCollapsed: false };
}

/** Where a key pressed on the panel's edge leaves it, or `undefined` for a key it ignores. */
export function nudgePanel(
  spec: PanelSpec,
  state: PanelState,
  key: string,
): PanelState | undefined {
  switch (key) {
    case 'ArrowLeft':
      return dragPanel(spec, state, panelSize(spec, state) - KEYBOARD_STEP);
    case 'ArrowRight':
      return state.isCollapsed
        ? { ...state, isCollapsed: false }
        : dragPanel(spec, state, state.width + KEYBOARD_STEP);
    case 'Home':
      return { width: spec.min, isCollapsed: false };
    case 'End':
      return { width: spec.max, isCollapsed: false };
    case 'Enter':
      return { ...state, isCollapsed: !state.isCollapsed };
    default:
      return undefined;
  }
}
