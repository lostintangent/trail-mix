import { describe, expect, test } from 'bun:test';
import {
  contrast,
  hexOf,
  oklchOf,
  over,
  parseColor,
  parseHex,
  quantized,
  type Rgb,
} from '../../shared/color.ts';
import { DEFAULT_ACCENT, DESK, MUTED_ALPHA, PANE, PAPER } from './palette.ts';
import { accentRule, accentTokens, readableAccent, type Theme } from './readableAccent.ts';

const THEMES: Theme[] = ['light', 'dark'];

/** The accent's worst contrast as text: on the desk, a pane and paper, and its tint over each. */
function worstContrast(accent: Rgb, theme: Theme) {
  const surfaces = [DESK, PANE, PAPER].map((halves) => parseColor(halves[theme])!);
  const tinted = surfaces.map((surface) => over(accent, MUTED_ALPHA[theme], surface));
  return Math.min(...[...surfaces, ...tinted].map((under) => contrast(accent, under)));
}

/** Picks across the whole color cube, the palest and darkest a member can pick among them. */
const PICKS = (() => {
  const steps = [0, 0x33, 0x66, 0x99, 0xcc, 0xff];
  const picks = ['#ffff99', '#1a73e8', '#ff0000', '#7c3aed'];
  for (const r of steps) {
    for (const g of steps) {
      for (const b of steps) picks.push(hexOf({ r: r / 255, g: g / 255, b: b / 255 }));
    }
  }
  return picks;
})();

describe('the default', () => {
  test('ink blue reads in both themes, so it would come through unchanged', () => {
    for (const theme of THEMES) {
      const blue = quantized(parseColor(DEFAULT_ACCENT[theme])!);
      expect(hexOf(readableAccent(blue, theme))).toBe(hexOf(blue));
    }
  });
});

describe('a pick', () => {
  test('reads at 4.5:1 or more as text and marks, in both themes', () => {
    for (const pick of PICKS) {
      for (const theme of THEMES) {
        const accent = parseHex(accentTokens(parseHex(pick)!, theme).accent)!;
        expect({ pick, theme, reads: worstContrast(accent, theme) >= 4.5 }).toEqual({
          pick,
          theme,
          reads: true,
        });
      }
    }
  });

  test('carries white or black text, whichever reads, at 4.5:1 or more', () => {
    for (const pick of PICKS) {
      for (const theme of THEMES) {
        const { accent, onAccent } = accentTokens(parseHex(pick)!, theme);
        expect(['#ffffff', '#000000']).toContain(onAccent);
        expect(contrast(parseHex(accent)!, parseHex(onAccent)!)).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  test('that already reads is used as it is', () => {
    expect(accentTokens(parseHex('#1e3a8a')!, 'light').accent).toBe('#1e3a8a');
    expect(accentTokens(parseHex('#f97316')!, 'dark').accent).toBe('#f97316');
  });

  test('that doesn’t read keeps its hue, and darkens on paper and lightens on charcoal', () => {
    const red = parseHex('#ff0000')!;
    const picked = oklchOf(red);
    const light = oklchOf(readableAccent(red, 'light'));
    const dark = oklchOf(readableAccent(parseHex('#990000')!, 'dark'));
    expect(light.l).toBeLessThan(picked.l);
    expect(dark.l).toBeGreaterThan(oklchOf(parseHex('#990000')!).l);
    expect(light.h).toBeCloseTo(picked.h, 0);
    expect(dark.h).toBeCloseTo(picked.h, 0);
  });
});

describe('the rule', () => {
  test('sets the four accent tokens, and the icon’s, for each theme', () => {
    const rule = accentRule('#FF0000')!;
    const light = accentTokens(parseHex('#ff0000')!, 'light');
    const dark = accentTokens(parseHex('#ff0000')!, 'dark');
    const [selector, body] = rule.split('{') as [string, string];
    expect(selector).toBe('[data-astryx-theme="trail-mix"]');
    const tokens = Object.fromEntries(
      body
        .replace(/\}$/, '')
        .split(';')
        .map((declaration) => [
          declaration.slice(0, declaration.indexOf(':')),
          declaration.slice(declaration.indexOf(':') + 1),
        ]),
    );
    const accent = `light-dark(${light.accent}, ${dark.accent})`;
    expect(tokens).toEqual({
      '--color-accent': accent,
      '--color-text-accent': accent,
      '--color-icon-accent': accent,
      '--color-on-accent': `light-dark(${light.onAccent}, ${dark.onAccent})`,
      '--color-accent-muted': `light-dark(${light.muted}, ${dark.muted})`,
    });
    expect(light.muted).toBe('rgb(194 0 0 / 0.09)');
    expect(dark.muted).toMatch(/ \/ 0\.14\)$/);
  });

  test('is only for a color a color input gives', () => {
    for (const pick of ['red', '#f00', 'oklch(0.5 0.2 30)', '}body{display:none', '']) {
      expect(accentRule(pick)).toBeUndefined();
    }
  });
});
