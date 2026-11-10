import * as stylex from '@stylexjs/stylex';

/**
 * Every value Astryx has no name for. Components use these or Astryx's tokens, never a literal.
 *
 * The airmail stripe is 3px tall at -45 degrees: vermilion 7px, a 4px gap, ink blue 7px, a 4px gap.
 */

const COARSE = '@media (pointer: coarse)';

/** Width picks the layout and pointer picks the size. Each component declares its own motion. */
export const media = stylex.defineConsts({
  phone: '@media (width < 768px)', // one pane at a time, on a sliding track
  coarse: COARSE, // every target at least 44px
  reducedMotion: '@media (prefers-reduced-motion: reduce)', // nothing moves
  forcedColors: '@media (forced-colors: active)', // shadows and fills are gone, so edges are drawn
});

export const tm = stylex.defineVars({
  // Geometry
  deskGap: '6px', // desk showing between panes
  paneRadius: '14px',
  sheetRadius: '12px', // a message, the composer
  target: { default: '32px', [COARSE]: '44px' },
  rowPad: { default: '8px', [COARSE]: '11px' },
  measure: '72ch', // longest line of message text

  // Color roles beyond Astryx's
  textQuiet: 'light-dark(oklch(0.52 0.015 265), oklch(0.66 0.02 265))', // previews, times: still 4.5:1
  paperFixed: 'oklch(0.975 0.004 85)', // HTML mail that sets its own colors sits on this in both themes
  highlight: 'oklch(0.86 0.17 92)', // the suite yellow: flagged, search match
  danger: 'light-dark(oklch(0.55 0.2 27), oklch(0.74 0.15 27))',
  shade: 'light-dark(#0000002b, #00000000)', // sheets cast a shadow in light mode only
  // A sheet's edge: a ring in the border color, and the shade below it.
  sheetEdge: '0 0 0 1px var(--color-border), 0 10px 28px -16px light-dark(#0000002b, #00000000)',
  stampVermilion: 'oklch(0.64 0.19 30)', // account colors, assigned in this order
  stampTeal: 'oklch(0.7 0.11 190)',
  stampViolet: 'oklch(0.62 0.17 300)',
  stampAmber: 'oklch(0.76 0.15 75)',
  stampGreen: 'oklch(0.68 0.15 150)',
  stampSlate: 'oklch(0.6 0.03 250)',

  // Type and motion
  serif: 'ui-serif, "New York", "Iowan Old Style", Georgia, serif', // conversation subjects only
  easeLayout: 'cubic-bezier(0.16, 1, 0.3, 1)', // panes and the phone track

  // Screen edges
  safeTop: 'max(env(safe-area-inset-top), 8px)',
  safeBottom: 'max(env(safe-area-inset-bottom), 8px)',
});
