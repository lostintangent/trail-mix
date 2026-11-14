import { colorVars, fontWeightVars, radiusVars } from '@astryxdesign/core/theme/tokens.stylex';
import * as stylex from '@stylexjs/stylex';
import { focusRing, media, tm } from '../../../app/theme/tokens.stylex.ts';

/**
 * How the sidebar draws its own controls, the tree's lines and chevrons, the `…` and the rail's
 * buttons, and how a line rises from the desk onto a pane.
 */
export const control = stylex.create({
  // Bare on the desk, tinted under a hovering pointer, and ringed inside its edge by the keyboard.
  bare: {
    borderWidth: 0,
    borderRadius: radiusVars['--radius-element'],
    backgroundColor: {
      default: 'transparent',
      ':hover': { default: null, '@media (hover: hover)': colorVars['--color-overlay-hover'] },
    },
    cursor: 'pointer',
    outline: {
      default: null,
      ':focus-visible': focusRing.line,
    },
    outlineOffset: focusRing.inside,
  },
  // One target square, with its icon at the center. A pinned control's room keeps the same square.
  target: {
    display: 'grid',
    placeItems: 'center',
    flexShrink: 0,
    width: tm.target,
    height: tm.target,
    padding: 0,
  },
});

/** How a line rises from the desk onto a pane: as the view, or folded around it. */
export const lift = stylex.create({
  // Selection lifts instead of tinting: the current view rises from the desk onto a pane.
  selected: {
    backgroundColor: {
      default: colorVars['--color-background-surface'],
      ':hover': colorVars['--color-background-surface'],
      [media.forcedColors]: 'Highlight',
    },
    boxShadow: `0 0 0 1px ${colorVars['--color-border']}`,
    color: {
      default: colorVars['--color-text-primary'],
      [media.forcedColors]: 'HighlightText',
    },
    fontWeight: fontWeightVars['--font-weight-semibold'],
    forcedColorAdjust: 'none',
  },
  // Folded around the view, a line rises with it, so the member still sees where they are.
  holding: {
    backgroundColor: {
      default: colorVars['--color-background-surface'],
      ':hover': colorVars['--color-background-surface'],
    },
    boxShadow: `0 0 0 1px ${colorVars['--color-border']}`,
    color: colorVars['--color-text-primary'],
  },
});
