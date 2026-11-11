import * as stylex from '@stylexjs/stylex';

/** Every value Astryx has no name for. Components use these or Astryx's tokens, never a literal. */

const COARSE = '@media (pointer: coarse)';
const VERMILION = 'oklch(0.64 0.19 30)';
const INK_BLUE = 'light-dark(oklch(0.5 0.19 265), oklch(0.77 0.13 265))';

/** Width picks the layout and pointer picks the size. Each component declares its own motion. */
export const media = stylex.defineConsts({
  phone: '@media (width < 768px)', // one pane at a time, on a sliding track
  coarse: COARSE, // every target at least 44px
  reducedMotion: '@media (prefers-reduced-motion: reduce)', // nothing moves
  forcedColors: '@media (forced-colors: active)', // shadows and fills are gone, so edges are drawn
});

export const tm = stylex.defineVars({
  // Geometry
  deskGap: '8px', // the gutter between sheets, as in Toy Box
  paneRadius: '14px',
  sheetRadius: '12px', // a message, the composer
  target: { default: '32px', [COARSE]: '44px' },
  rowPad: { default: '8px', [COARSE]: '11px' },
  measure: '72ch', // longest line of message text
  swatch: '14px', // a color to pick, the size of an icon

  // Color roles beyond Astryx's
  textQuiet: 'light-dark(oklch(0.52 0.015 265), oklch(0.66 0 0))', // previews, times: still 4.5:1
  paperFixed: 'oklch(0.975 0.004 85)', // HTML mail on light paper sits on this in both themes
  highlight: 'oklch(0.86 0.17 92)', // the suite yellow: flagged, search match
  onHighlight: 'oklch(0.25 0.03 265)', // ink on the highlighter, dark in both themes
  danger: 'light-dark(oklch(0.55 0.2 27), oklch(0.74 0.15 27))',
  shade: 'light-dark(#0000002b, #00000000)', // sheets cast a shadow in light mode only
  // A sheet's edge: a ring in the border color, and the shade below it.
  sheetEdge: '0 0 0 1px var(--color-border), 0 10px 28px -16px light-dark(#0000002b, #00000000)',
  stampVermilion: VERMILION, // account colors, assigned in this order
  stampTeal: 'oklch(0.7 0.11 190)',
  stampViolet: 'oklch(0.62 0.17 300)',
  stampAmber: 'oklch(0.76 0.15 75)',
  stampGreen: 'oklch(0.68 0.15 150)',
  stampSlate: 'oklch(0.6 0.03 250)',
  // Airmail: this message is leaving. A stripe 3px tall at -45 degrees: vermilion 7px, a 4px gap,
  // ink blue 7px, a 4px gap. The blue is ink blue whatever accent the member picks: palette.ts's
  // default accent, written out because StyleX can't evaluate an import.
  airmail: `repeating-linear-gradient(-45deg, ${VERMILION} 0 7px, #0000 7px 11px, ${INK_BLUE} 11px 18px, #0000 18px 22px)`,
  airmailHeight: '3px',
  airmailRepeat: '31.1127px', // the pattern's 22px across its stripes, measured along it: 22√2
  airmailTurn: '1s', // how long running airmail takes to slide one repeat
  // A resize handle on hover or drag, as in Toy Box: a line of the accent that fades out toward
  // both ends.
  resizeAccent: 'linear-gradient(transparent, var(--color-accent) 20% 80%, transparent)',

  // Type and motion
  serif: 'ui-serif, "New York", "Iowan Old Style", Georgia, serif', // conversation subjects only
  easeLayout: 'cubic-bezier(0.16, 1, 0.3, 1)', // panes and the phone track
  // How long something on its way may take before its skeleton shows, so a fast answer shows none.
  skeletonDelay: '300ms',

  // Screen edges
  safeTop: 'max(env(safe-area-inset-top), 8px)',
  safeBottom: 'max(env(safe-area-inset-bottom), 8px)',
});
