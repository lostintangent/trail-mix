import { describe, expect, test } from 'bun:test';
import {
  contrast,
  hexOf,
  oklchOf,
  over,
  parseColor,
  parseHex,
  parseOklch,
  quantized,
  readableShade,
  rgbOf,
  type Rgb,
} from './color.ts';

const WHITE: Rgb = { r: 1, g: 1, b: 1 };
const BLACK: Rgb = { r: 0, g: 0, b: 0 };

describe('reading colors', () => {
  test('a color input’s #rrggbb, in either case, and nothing else', () => {
    expect(parseHex('#3366CC')).toEqual({ r: 0.2, g: 0.4, b: 0.8 });
    expect(parseHex('#3366cc')).toEqual({ r: 0.2, g: 0.4, b: 0.8 });
    for (const other of ['#36c', '3366cc', '#3366cg', '#3366cc80', 'blue', '']) {
      expect(parseHex(other)).toBeUndefined();
    }
  });

  test('oklch() as the theme writes it, with or without alpha', () => {
    expect(parseOklch('oklch(0.5 0.19 265)')).toEqual({ l: 0.5, c: 0.19, h: 265 });
    expect(parseOklch('oklch(0.77 0.13 265 / 0.14)')).toEqual({ l: 0.77, c: 0.13, h: 265 });
    expect(parseOklch('oklch(50% 0.19 265)')).toBeUndefined();
    expect(hexOf(parseColor('oklch(1 0 0)')!)).toBe('#ffffff');
    expect(parseColor('#000000')).toEqual(BLACK);
  });
});

describe('OKLCH', () => {
  test('matches CSS Color 4 for the primaries and the extremes', () => {
    const near = (hex: string) => {
      const { l, c, h } = oklchOf(parseHex(hex)!);
      return [l, c, h].map((v) => Number(v.toFixed(3)));
    };
    expect(near('#ffffff')).toEqual([1, 0, 0]);
    expect(near('#000000')).toEqual([0, 0, 0]);
    expect(near('#ff0000')).toEqual([0.628, 0.258, 29.234]);
    expect(near('#0000ff')).toEqual([0.452, 0.313, 264.052]);
  });

  test('takes every sRGB color there and back unchanged', () => {
    for (let r = 0; r <= 255; r += 51) {
      for (let g = 0; g <= 255; g += 51) {
        for (let b = 0; b <= 255; b += 51) {
          const hex = hexOf({ r: r / 255, g: g / 255, b: b / 255 });
          expect(hexOf(rgbOf(oklchOf(parseHex(hex)!)))).toBe(hex);
        }
      }
    }
  });

  test('a color beyond sRGB comes back with less chroma, at the same lightness and hue', () => {
    const vivid = { l: 0.5, c: 0.4, h: 265 };
    const shown = rgbOf(vivid);
    for (const channel of [shown.r, shown.g, shown.b]) {
      expect(channel).toBeGreaterThanOrEqual(0);
      expect(channel).toBeLessThanOrEqual(1);
    }
    const back = oklchOf(shown);
    expect(back.l).toBeCloseTo(0.5, 3);
    expect(back.h).toBeCloseTo(265, 0);
    expect(back.c).toBeLessThan(0.4);
    expect(back.c).toBeGreaterThan(0.25);
  });
});

test('contrast is WCAG’s ratio, the same either way round', () => {
  expect(contrast(WHITE, BLACK)).toBe(21);
  expect(contrast(BLACK, WHITE)).toBe(21);
  expect(contrast(WHITE, WHITE)).toBe(1);
  // The gray that famously just passes on white.
  expect(contrast(parseHex('#767676')!, WHITE)).toBeCloseTo(4.54, 2);
});

test('a screen shows 8 bits a channel, and a tint mixes with what lies under it', () => {
  const color = { r: 0.5, g: 0.1004, b: 0.999 };
  expect(hexOf(color)).toBe('#801aff');
  expect(quantized(color)).toEqual(parseHex('#801aff')!);
  expect(over(WHITE, 0.25, BLACK)).toEqual({ r: 0.25, g: 0.25, b: 0.25 });
});

describe('the readable shade', () => {
  const paper = parseHex('#ffffff')!;
  const charcoal = parseColor('oklch(0.25 0 0)')!;
  const readsOn = (surface: Rgb) => (shade: Rgb) => contrast(shade, surface) >= 4.5;

  test('of a color that already reads is the color, as the screen shows it', () => {
    const navy = { r: 0.1, g: 0.2, b: 0.5004 };
    expect(readableShade(navy, 'darker', readsOn(paper))).toEqual(quantized(navy));
  });

  test('keeps the hue and moves lightness the way it’s asked, just far enough', () => {
    for (const [hex, toward, surface] of [
      ['#ff0000', 'darker', paper],
      ['#ffff99', 'darker', paper],
      ['#1a73e8', 'lighter', charcoal],
      ['#550000', 'lighter', charcoal],
    ] as const) {
      const picked = oklchOf(parseHex(hex)!);
      const shade = oklchOf(readableShade(parseHex(hex)!, toward, readsOn(surface)));
      const sign = toward === 'darker' ? -1 : 1;
      expect({ hex, moved: Math.sign(shade.l - picked.l) }).toEqual({ hex, moved: sign });
      expect(shade.h).toBeCloseTo(picked.h, 0);
      expect(contrast(rgbOf(shade), surface)).toBeGreaterThanOrEqual(4.5);
      const nearer = quantized(rgbOf({ ...shade, l: shade.l - sign * 0.01 }));
      expect({ hex, nearerReads: readsOn(surface)(nearer) }).toEqual({ hex, nearerReads: false });
    }
  });

  test('is black or white when nothing nearer reads', () => {
    const never = (shade: Rgb) => hexOf(shade) === '#000000' || hexOf(shade) === '#ffffff';
    expect(hexOf(readableShade(parseHex('#808080')!, 'darker', never))).toBe('#000000');
    expect(hexOf(readableShade(parseHex('#808080')!, 'lighter', never))).toBe('#ffffff');
  });
});
