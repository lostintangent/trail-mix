import {
  contrast,
  hexOf,
  over,
  parseColor,
  parseHex,
  quantized,
  readableShade,
  type Rgb,
} from '../../shared/color.ts';
import { DESK, MUTED_ALPHA, PANE, PAPER, type Halves } from './palette.ts';

/**
 * The accent a member picks, made readable in both themes.
 *
 * The accent is text and marks on the desk, a pane and paper, and on its own muted tint over any
 * of them, and text is written on it. In each theme a pick is used as it is when it reads there at
 * 4.5:1, and otherwise only its lightness moves, darker on paper and lighter on charcoal, just as
 * far as it must. Text on it is white or black, whichever reads better. Ink blue, the default,
 * already reads in both themes, so it would come through unchanged.
 */

export type Theme = keyof Halves;

/** The tokens an accent sets in one theme, as CSS colors. */
export type AccentTokens = { accent: string; onAccent: string; muted: string };

/** 4.5:1, with room for a browser that blends the muted tint a shade differently. */
const READABLE = 4.55;

const WHITE: Rgb = { r: 1, g: 1, b: 1 };
const BLACK: Rgb = { r: 0, g: 0, b: 0 };

/** The accent's tokens in place of the default's, for a pick given as `#rrggbb`. */
export function accentRule(pick: string): string | undefined {
  const color = parseHex(pick);
  if (!color) return undefined;
  const light = accentTokens(color, 'light');
  const dark = accentTokens(color, 'dark');
  const pair = (token: keyof AccentTokens) => `light-dark(${light[token]}, ${dark[token]})`;
  // The theme's own tokens are layered, so this unlayered rule outranks them on every element that
  // carries the theme, `<html>` first. The shell names the theme there before anything runs.
  return (
    `[data-astryx-theme="trail-mix"]{` +
    `--color-accent:${pair('accent')};` +
    `--color-text-accent:${pair('accent')};` +
    `--color-icon-accent:${pair('accent')};` +
    `--color-on-accent:${pair('onAccent')};` +
    `--color-accent-muted:${pair('muted')}}`
  );
}

export function accentTokens(color: Rgb, theme: Theme): AccentTokens {
  const accent = readableAccent(color, theme);
  const onAccent = contrast(accent, WHITE) >= contrast(accent, BLACK) ? WHITE : BLACK;
  const byte = (v: number) => Math.round(v * 255);
  return {
    accent: hexOf(accent),
    onAccent: hexOf(onAccent),
    muted: `rgb(${byte(accent.r)} ${byte(accent.g)} ${byte(accent.b)} / ${MUTED_ALPHA[theme]})`,
  };
}

/** The shade of `color` nearest it that reads as text and marks in `theme`. */
export function readableAccent(color: Rgb, theme: Theme): Rgb {
  // Black reads on paper and white on charcoal, so the far end of the search always reads.
  return readableShade(color, theme === 'light' ? 'darker' : 'lighter', (shade) => {
    return worstContrast(shade, theme) >= READABLE;
  });
}

/** The worst contrast an accent has with what it lies on in `theme`. */
function worstContrast(accent: Rgb, theme: Theme): number {
  return Math.min(
    ...SURFACES[theme].flatMap((surface) => [
      contrast(accent, surface),
      contrast(accent, over(accent, MUTED_ALPHA[theme], surface)),
    ]),
  );
}

const SURFACES: Record<Theme, Rgb[]> = {
  light: [DESK.light, PANE.light, PAPER.light].map(surface),
  dark: [DESK.dark, PANE.dark, PAPER.dark].map(surface),
};

function surface(css: string): Rgb {
  const color = parseColor(css);
  if (!color) throw new Error(`The palette has a color the accent can't measure: ${css}`);
  return quantized(color);
}
