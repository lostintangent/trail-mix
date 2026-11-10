/**
 * The colors the theme is made of, as the halves `trail-mix.ts` pairs with `light-dark()`, so the
 * accent is measured against the same surfaces it lies on. Light mode carries two hues, warm paper
 * (85) and blue-black ink (265). Dark mode is the family's charcoal, with no hue at all.
 */
export type Halves = { light: string; dark: string };

/** Behind everything. */
export const DESK: Halves = { light: 'oklch(0.94 0.008 85)', dark: 'oklch(0.165 0 0)' };
/** The list, the reader, menus. */
export const PANE: Halves = { light: 'oklch(0.985 0.004 85)', dark: 'oklch(0.21 0 0)' };
/** A message, the composer, a lifted row. */
export const PAPER: Halves = { light: '#ffffff', dark: 'oklch(0.25 0 0)' };

/** Ink blue: the accent until the member picks another. */
export const DEFAULT_ACCENT: Halves = {
  light: 'oklch(0.5 0.19 265)',
  dark: 'oklch(0.77 0.13 265)',
};

/** How strongly the accent tints what it marks quietly, such as a tag, in each theme. */
export const MUTED_ALPHA = { light: 0.09, dark: 0.14 } as const;
