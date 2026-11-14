import * as stylex from '@stylexjs/stylex';

/** Every value Astryx has no name for. Components use these or Astryx's tokens, never a literal. */

const COARSE = '@media (pointer: coarse)';
const PHONE = '@media (width < 768px)';
const VERMILION = 'oklch(0.64 0.19 30)';
const INK_BLUE = 'light-dark(oklch(0.5 0.19 265), oklch(0.77 0.13 265))';

/** Width picks the layout and pointer picks the size. Each component declares its own motion. */
export const media = stylex.defineConsts({
  phone: PHONE, // one pane at a time, on a sliding track
  coarse: COARSE, // every target at least 44px
  reducedMotion: '@media (prefers-reduced-motion: reduce)', // nothing moves
  forcedColors: '@media (forced-colors: active)', // shadows and fills are gone, so edges are drawn
});

export const tm = stylex.defineVars({
  // Geometry
  // The gutter between sheets: 9px of desk between their rings, which lie outside them, as Toy Box
  // shows between its cards' borders, a card's 4px inset either side of a 1px rule.
  deskGap: '11px',
  deskEdge: '9px', // the desk about them: 8px outside their rings, as Toy Box shows about its cards
  // The desk about the sidebar, which has no ring: from the window's edge and from the list.
  sidebarMargin: '8px',
  // From the sidebar's edge to its lines, which puts its icons 20px in, as GistPad's are. A phone's
  // sidebar fills the screen, so it keeps a wider margin, and so does one built for a finger.
  sidebarInset: { default: '4px', [COARSE]: '9px', [PHONE]: '9px' },
  // The rail the sidebar folds to: twice the way to its icons' middle (its inset, a line's 8px
  // padding and half a 16px icon), so the fold button and the gear head that column in both forms.
  sidebarRail: { default: '40px', [COARSE]: '50px' },
  paneRadius: '14px',
  sheetRadius: '12px', // a message, the composer
  target: { default: '32px', [COARSE]: '44px' },
  // The room a list leaves below its last row for controls floating over its foot, which keys keep
  // the selection clear of too. None, except where the list pane sets it for a phone's island.
  listFoot: '0px',
  rowPad: { default: '8px', [COARSE]: '11px' },
  measure: '72ch', // longest line of message text
  swatch: '14px', // a color to pick, the size of an icon
  accentFill: '24px', // New message's fill in the sidebar's foot, a line's height at any pointer
  statusDot: '6px', // the dot before a list's word that the device is offline
  // A GitHub thread's chip: a pill one line of small text tall, with its kind's icon
  chipHeight: { default: '16px', [COARSE]: '20px' },
  chipText: { default: '11px', [COARSE]: '12.5px' },
  chipIcon: { default: '11px', [COARSE]: '13px' },

  // Color roles beyond Astryx's
  textQuiet: 'light-dark(oklch(0.52 0.015 265), oklch(0.66 0 0))', // previews, times: still 4.5:1
  // The short rule that parts the foot's gear from the name, the rail's groups, and a toast's action
  // from its close: quiet ink at half
  rule: 'light-dark(oklch(0.52 0.015 265 / 0.5), oklch(0.66 0 0 / 0.5))',
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
