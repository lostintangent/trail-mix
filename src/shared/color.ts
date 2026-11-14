/**
 * Color math for keeping text readable: colors read as sRGB, moved in OKLCH, where lightness
 * changes without the hue drifting, and measured by WCAG's contrast ratio. Pure, and free of the
 * DOM. The accent a member picks and the colors mail sets both go through `readableShade`.
 */

/** A color in OKLCH: lightness 0 to 1, chroma, and hue in degrees. */
type Oklch = { l: number; c: number; h: number };

/** A color in sRGB, each channel 0 to 1. */
export type Rgb = { r: number; g: number; b: number };

/** `#rrggbb`, as a color input gives it, or undefined for anything else. */
export function parseHex(hex: string): Rgb | undefined {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim());
  if (!match) return undefined;
  const [r, g, b] = match.slice(1).map((pair) => parseInt(pair, 16) / 255) as [
    number,
    number,
    number,
  ];
  return { r, g, b };
}

/** `oklch(l c h)` or `oklch(l c h / a)` as the theme writes it, its alpha set aside. */
export function parseOklch(css: string): Oklch | undefined {
  const match = /^oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*(?:\/\s*[\d.]+\s*)?\)$/.exec(
    css.trim(),
  );
  if (!match) return undefined;
  const [l, c, h] = match.slice(1).map(Number) as [number, number, number];
  return { l, c, h };
}

/** A color as the theme writes it, `#rrggbb` or `oklch()`, in sRGB. */
export function parseColor(css: string): Rgb | undefined {
  const oklch = parseOklch(css);
  return oklch ? rgbOf(oklch) : parseHex(css);
}

/**
 * `#rrggbb`. A screen shows sRGB in 8 bits a channel, so this is the color it shows, and
 * `quantized` the same color as numbers to measure.
 */
export function hexOf(color: Rgb): string {
  const byte = (v: number) =>
    Math.round(v * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${byte(color.r)}${byte(color.g)}${byte(color.b)}`;
}

export function quantized({ r, g, b }: Rgb): Rgb {
  const byte = (v: number) => Math.round(v * 255) / 255;
  return { r: byte(r), g: byte(g), b: byte(b) };
}

/** What a screen shows when `top`, at `alpha`, lies over `under`. */
export function over(top: Rgb, alpha: number, under: Rgb): Rgb {
  const mix = (a: number, b: number) => a * alpha + b * (1 - alpha);
  return { r: mix(top.r, under.r), g: mix(top.g, under.g), b: mix(top.b, under.b) };
}

export function oklchOf({ r, g, b }: Rgb): Oklch {
  const [lr, lg, lb] = [r, g, b].map(toLinear) as [number, number, number];
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  const c = Math.hypot(a, bb);
  const h = c < 1e-4 ? 0 : ((Math.atan2(bb, a) * 180) / Math.PI + 360) % 360;
  return { l: L, c: c < 1e-4 ? 0 : c, h };
}

/**
 * The sRGB color nearest an OKLCH one: the same lightness and hue, with chroma lowered until it
 * fits sRGB, since the screens it shows on can show no more.
 */
export function rgbOf(color: Oklch): Rgb {
  const fits = (rgb: Rgb) => [rgb.r, rgb.g, rgb.b].every((v) => v >= -1e-4 && v <= 1 + 1e-4);
  let rgb = unclamped(color);
  if (!fits(rgb)) {
    let [low, high] = [0, color.c];
    for (let step = 0; step < 24; step++) {
      const mid = (low + high) / 2;
      if (fits(unclamped({ ...color, c: mid }))) low = mid;
      else high = mid;
    }
    rgb = unclamped({ ...color, c: low });
  }
  const clamp = (v: number) => Math.min(1, Math.max(0, v));
  return { r: clamp(rgb.r), g: clamp(rgb.g), b: clamp(rgb.b) };
}

/**
 * The shade of `color` nearest it that `reads`: the same hue and chroma, with its lightness moved
 * `toward` darker or lighter just as far as it must, as the screen shows it. Black or white, at
 * the far end, is the last resort, so `reads` should hold there.
 */
export function readableShade(
  color: Rgb,
  toward: 'darker' | 'lighter',
  reads: (shade: Rgb) => boolean,
): Rgb {
  const shown = quantized(color);
  if (reads(shown)) return shown;
  const { l, c, h } = oklchOf(color);
  const at = (lightness: number) => quantized(rgbOf({ l: lightness, c, h }));
  let [fails, passes] = [l, toward === 'darker' ? 0 : 1];
  for (let step = 0; step < 24; step++) {
    const middle = (fails + passes) / 2;
    if (reads(at(middle))) passes = middle;
    else fails = middle;
  }
  return at(passes);
}

/** WCAG's contrast ratio between two colors, from 1 to 21. */
export function contrast(a: Rgb, b: Rgb): number {
  const [lighter, darker] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (lighter + 0.05) / (darker + 0.05);
}

function luminance({ r, g, b }: Rgb): number {
  const [lr, lg, lb] = [r, g, b].map(toLinear) as [number, number, number];
  return 0.2126 * lr + 0.7152 * lg + 0.0722 * lb;
}

function unclamped({ l, c, h }: Oklch): Rgb {
  const radians = (h * Math.PI) / 180;
  const a = c * Math.cos(radians);
  const b = c * Math.sin(radians);
  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return {
    r: toGamma(4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_),
    g: toGamma(-1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_),
    b: toGamma(-0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_),
  };
}

function toLinear(v: number): number {
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

function toGamma(v: number): number {
  const sign = v < 0 ? -1 : 1;
  const abs = Math.abs(v);
  return sign * (abs <= 0.0031308 ? abs * 12.92 : 1.055 * abs ** (1 / 2.4) - 0.055);
}
