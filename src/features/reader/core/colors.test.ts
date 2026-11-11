import { describe, expect, test } from 'bun:test';
import { contrast, hexOf, oklchOf, parseColor, parseHex, type Rgb } from '../../../shared/color.ts';
import {
  isPaperWhite,
  liftedColor,
  onWhite,
  READS,
  schemeOf,
  SHADED,
  shadedPaper,
  shadingOf,
  type DarkPaper,
} from './colors.ts';

const color = (css: string): Rgb => {
  const rgb = parseColor(css);
  if (!rgb) throw new Error(`${css} is no color`);
  return rgb;
};

/** Charcoal paper and the ink on it, as the dark theme sets them. */
const dark: DarkPaper = {
  paper: color('oklch(0.25 0 0)'),
  ink: color('oklch(0.93 0 0)'),
  lightInk: color('oklch(0.22 0.02 265)'),
};
const white = color('#ffffff');
const strongest = contrast(dark.ink, dark.paper);

describe('a color mail sets, on the dark theme’s paper', () => {
  test('reads as strongly as it did on white, keeping its hue', () => {
    for (const css of ['#555555', '#666666', '#0563c1', '#d73a49', '#008000', '#954f72']) {
      const before = color(css);
      const after = liftedColor(before, dark);
      expect(contrast(after, dark.paper)).toBeGreaterThanOrEqual(contrast(before, white));
      expect(contrast(after, dark.paper)).toBeLessThan(contrast(before, white) + 0.15);
      if (oklchOf(before).c > 0.02) {
        expect(oklchOf(after).h).toBeCloseTo(oklchOf(before).h, 0);
      }
    }
  });

  test('reads at 4.5:1 or more, however faint it was on white', () => {
    for (const css of ['#ff0000', '#777777', '#2e8b57', '#d2691e']) {
      const after = liftedColor(color(css), dark);
      expect(contrast(after, dark.paper)).toBeGreaterThanOrEqual(READS);
      expect(contrast(after, dark.paper)).toBeLessThan(READS + 0.15);
    }
  });

  test('that already reads stays as it is', () => {
    for (const css of ['#cccccc', '#ffffff', '#99ccff']) {
      expect(hexOf(liftedColor(color(css), dark))).toBe(css);
    }
  });

  test('black and near-black become the theme’s ink', () => {
    for (const css of ['#000000', '#111111', '#222222', '#1a1a2e']) {
      expect(liftedColor(color(css), dark)).toEqual(dark.ink);
    }
  });

  test('never reads more strongly than the theme’s ink, so a dark color keeps its hue', () => {
    const navy = liftedColor(color('#000080'), dark);
    expect(contrast(navy, dark.paper)).toBeLessThanOrEqual(strongest + 0.15);
    expect(contrast(navy, dark.paper)).toBeGreaterThanOrEqual(strongest - 0.15);
    expect(oklchOf(navy).h).toBeCloseTo(oklchOf(color('#000080')).h, -1);
    expect(navy).not.toEqual(dark.ink);
  });

  test('a gray lighter than near-black stays a gray, short of the ink', () => {
    const gray = liftedColor(color('#333333'), dark);
    expect(oklchOf(gray).c).toBeLessThan(0.001);
    expect(contrast(gray, dark.paper)).toBeLessThan(strongest);
  });
});

describe('a background mail paints, in the dark theme', () => {
  const darkened = (css: string) => {
    const shading = shadingOf(color(css), dark);
    if (shading.as !== 'darkened') throw new Error(`${css} is ${shading.as}`);
    return shading.color;
  };

  test('is the theme’s paper where it was white', () => {
    expect(shadingOf(color('#ffffff'), dark)).toEqual({ as: 'paper' });
    expect(shadingOf(color('#fdfdfd'), dark)).toEqual({ as: 'paper' });
  });

  test('darkens where it was light, standing from the paper as it stood from white', () => {
    for (const css of ['#f4f4f4', '#f3f2f1', '#eef2f5', '#fff8e1', '#e8f0fe']) {
      const before = color(css);
      const after = darkened(css);
      const stood = Math.min(contrast(before, white), SHADED);
      expect(contrast(after, dark.paper)).toBeLessThanOrEqual(stood + 0.01);
      expect(contrast(after, dark.paper)).toBeGreaterThan(stood - 0.06);
      expect(oklchOf(after).l).toBeLessThan(oklchOf(dark.ink).l);
    }
  });

  test('keeps its hue, muted, where it was tinted', () => {
    for (const css of ['#fff8e1', '#e8f0fe', '#eef3f8', '#fde8e8']) {
      const [before, after] = [oklchOf(color(css)), oklchOf(darkened(css))];
      expect(Math.abs(((after.h - before.h + 540) % 360) - 180)).toBeLessThan(12);
      expect(after.c).toBeLessThan(before.c);
    }
  });

  test('stands no further from the paper than SHADED, however dark it was', () => {
    for (const css of ['#dddddd', '#d6e4f0', '#cccccc']) {
      expect(contrast(darkened(css), dark.paper)).toBeLessThanOrEqual(SHADED + 0.01);
    }
    expect(contrast(shadedPaper(dark), dark.paper)).toBeCloseTo(SHADED, 1);
  });

  test('is kept as sent where it is strong or dark', () => {
    for (const css of [
      '#1a73e8',
      '#ffcc00',
      '#ffe066',
      '#c4512b',
      '#2f2f2f',
      '#000000',
      '#999999',
    ]) {
      expect(shadingOf(color(css), dark)).toEqual({ as: 'kept' });
    }
  });
});

test('a background is white paper only within a hair of white', () => {
  for (const css of ['#ffffff', '#fdfdfd', '#fafafa']) expect(isPaperWhite(color(css))).toBe(true);
  for (const css of ['#f5f5f7', '#eeeeee', '#fff8e1', '#000000']) {
    expect(isPaperWhite(color(css))).toBe(false);
  }
});

test('a translucent color is what its sender saw over white', () => {
  const black = { r: 0, g: 0, b: 0 };
  expect(hexOf(onWhite({ rgb: black, alpha: 0.54 }))).toBe('#757575');
  expect(onWhite({ rgb: black, alpha: 0 })).toEqual(white);
  expect(onWhite({ rgb: black, alpha: 1 })).toEqual(black);
  expect(parseHex('#757575')).toEqual(color('#757575'));
});

test('a color scheme allows dark if it names dark at all, and is light if it names only light', () => {
  expect(schemeOf('light dark')).toBe('dark');
  expect(schemeOf('dark')).toBe('dark');
  expect(schemeOf('only dark')).toBe('dark');
  expect(schemeOf('Light, Dark')).toBe('dark');
  expect(schemeOf('light')).toBe('light');
  expect(schemeOf('only light')).toBe('light');
  expect(schemeOf('normal')).toBeUndefined();
  expect(schemeOf('')).toBeUndefined();
});
