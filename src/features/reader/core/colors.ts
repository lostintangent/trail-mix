import {
  contrast,
  hexOf,
  oklchOf,
  over,
  readableShade,
  rgbOf,
  type Rgb,
} from '../../../shared/color.ts';

/**
 * Mail's own colors on the theme's paper.
 *
 * Mail is written for white paper. In the dark theme it sits on charcoal instead. A white
 * background is only the sender's paper, and becomes the theme's. Each light background it
 * paints, a gray wrapper or a pale callout, darkens in its own hue, standing as far from the
 * charcoal as it stood from white, up to `SHADED`. Each color it sets on text or a line is lifted
 * to read on the lightest of those: its hue kept, and lightened until it reads as strongly as it
 * did on white, and at least 4.5:1. Black and near-black become the theme's ink.
 *
 * Strong colors and dark ones, such as a button or a footer, and every image are kept as sent,
 * and so is what lies on them: their element takes the light color scheme, so the colors inside
 * it are the sender's own, and text with no color of its own on a light one takes the light
 * theme's ink.
 *
 * Mail that declares a dark color scheme shows its own dark styles. Mail that asks for light only,
 * paints an image with no color under it, or sets a color no browser reads the same way stays on
 * light paper in both themes.
 *
 * Each color is rewritten as `light-dark(original, dark)`, so one sanitized message serves both
 * themes, and its frame's color scheme picks between them.
 */

/** The dark theme's paper and the ink written on it, and the light theme's ink. */
export type DarkPaper = { paper: Rgb; ink: Rgb; lightInk: Rgb };

/** The paper a message sits on: the theme's, or light paper in both themes. */
export type Paper = 'theme' | 'light';

/** A color as a screen shows it, and how opaque it is. */
export type Seen = { rgb: Rgb; alpha: number };

/** The contrast every color mail sets keeps on the dark theme's paper. */
export const READS = 4.5;

/**
 * A color mail sets on text or a line, as it reads on the dark theme's paper: as strongly as on
 * white, and at least `READS`, but never more strongly than the theme's own ink.
 */
export function liftedColor(color: Rgb, dark: DarkPaper): Rgb {
  const strongest = contrast(dark.ink, dark.paper);
  const wanted = Math.min(Math.max(contrast(color, WHITE), READS), strongest);
  if (wanted >= strongest && oklchOf(color).c < NEUTRAL_CHROMA) return dark.ink;
  return readableShade(color, 'lighter', (shade) => contrast(shade, dark.paper) >= wanted);
}

/** Whether a background is just the white paper mail is written on, within a hair of white. */
export function isPaperWhite(color: Rgb): boolean {
  return contrast(color, WHITE) < 1.05;
}

/**
 * The furthest a darkened background stands from the dark theme's paper, as a contrast ratio. A
 * light gray stands about this far from white, and the text lifted onto charcoal reads on it too.
 */
export const SHADED = 1.4;

/** How a background mail paints shows in the dark theme. */
export type Shading =
  /** White paper, which becomes the theme's. */
  | { as: 'paper' }
  /** A light background, darkened in its own hue. */
  | { as: 'darkened'; color: Rgb }
  /** A strong or dark color, kept as sent, as what lies on it is. */
  | { as: 'kept' };

/**
 * What becomes of a background mail paints, in the dark theme. A light one, at least `LIGHT` in
 * OKLCH lightness and no more saturated than a tint, darkens: its hue kept, its chroma muted, and
 * as much lighter than the paper as it was darker than white, up to `SHADED`.
 */
export function shadingOf(color: Rgb, dark: DarkPaper): Shading {
  if (isPaperWhite(color)) return { as: 'paper' };
  const { l, c, h } = oklchOf(color);
  if (l < LIGHT || c > TINT) return { as: 'kept' };
  const lightest = Math.min(contrast(color, WHITE), SHADED) * contrast(dark.paper, BLACK);
  const muted = rgbOf({ l, c: c * MUTED, h });
  return {
    as: 'darkened',
    color: readableShade(muted, 'darker', (shade) => contrast(shade, BLACK) <= lightest),
  };
}

/** The lightest a darkened background can be: the dark theme's paper, `SHADED` lighter. */
export function shadedPaper(dark: DarkPaper): Rgb {
  const lightest = SHADED * contrast(dark.paper, BLACK);
  return readableShade(dark.paper, 'lighter', (shade) => contrast(shade, BLACK) >= lightest);
}

/** Whether a kept color is light enough that text on it reads better in the light theme's ink. */
export function wantsLightInk(color: Rgb, dark: DarkPaper): boolean {
  return contrast(dark.lightInk, color) >= contrast(dark.ink, color);
}

/** A color as its sender saw it, over white paper where it lets some through. */
export function onWhite({ rgb, alpha }: Seen): Rgb {
  return alpha >= 1 ? rgb : over(rgb, alpha, WHITE);
}

/** Which scheme a `color-scheme` value or meta asks for: dark if it allows dark at all. */
export function schemeOf(value: string): 'dark' | 'light' | undefined {
  const words = value.toLowerCase().split(/[\s,]+/);
  if (words.includes('dark')) return 'dark';
  return words.includes('light') ? 'light' : undefined;
}

/** Values that set no color of their own, or one the frame's color scheme already adapts. */
const KEEPS = /^(|inherit|initial|unset|revert|revert-layer|currentcolor|transparent|none)$/i;
const ADAPTS =
  /^(light-dark\(.*|canvas|canvastext|linktext|visitedtext|activetext|buttonface|buttontext|buttonborder|field|fieldtext|highlight|highlighttext|selecteditem|selecteditemtext|mark|marktext|graytext|accentcolor|accentcolortext)$/i;

/** The properties that color text or a line, each lifted on the dark theme's paper. */
const LINES = [
  'color',
  '-webkit-text-fill-color',
  'text-decoration-color',
  'border-top-color',
  'border-right-color',
  'border-bottom-color',
  'border-left-color',
  'outline-color',
  'column-rule-color',
];

/** Every property a message colors with, painted or on a line. */
const COLORED = new Set(['background-color', 'background-image', ...LINES]);

/**
 * What adapting a declaration block did: whether it changed the block, and whether it keeps a
 * light color as sent and sets no text color of its own, so that in the dark theme its text needs
 * the light theme's ink. Text inherits the color its parent shows, and charcoal's ink can't be
 * read on a light color.
 */
export type Adapted = { changed: boolean; needsInk: boolean };

/** Declarations a legacy color attribute adds to its element's style, as `adapt` would write them. */
export type FromAttribute = { declarations: [name: string, value: string][]; needsInk: boolean };

/**
 * What a walk through a message learns about its colors, and the rewrites that let them read on
 * the dark theme's paper. Declarations and attributes are handed to it as the walk meets them.
 */
export function mailColors(dark: DarkPaper) {
  const read = colorReader(MOST_COLORS);
  const lifted = new Map<string, string | null>();
  // Text is lifted to read on the lightest darkened background, so it reads on any of them.
  const behindText = { ...dark, paper: shadedPaper(dark) };
  let scheme: 'dark' | 'light' | undefined;
  let keepsLight = false;

  // A rewrite matters only for mail that declares no scheme of its own, and not on light paper.
  const adapting = () => scheme === undefined && !keepsLight;

  /** The dark side of `light-dark()` for a color on text or a line, or null for one unread. */
  const liftedOf = (css: string): string | null => {
    let shade = lifted.get(css);
    if (shade === undefined) {
      const seen = read(css);
      shade = seen ? hexOf(liftedColor(onWhite(seen), behindText)) : null;
      lifted.set(css, shade);
    }
    return shade;
  };

  /** The declarations that keep a color as sent, with everything on it: its own color scheme. */
  const kept = (color: Rgb, ownsInk: boolean): FromAttribute => ({
    declarations: [['color-scheme', 'light']],
    needsInk: !ownsInk && wantsLightInk(color, dark),
  });

  /**
   * The declarations for a background a message paints, as a color and maybe an image: darkened,
   * given way to the paper, or kept as sent. Null where the message stays on light paper instead.
   */
  const painted = (css: string, hasImage: boolean, ownsInk: boolean): FromAttribute | null => {
    const seen = KEEPS.test(css) || ADAPTS.test(css) ? undefined : read(css);
    if (seen === undefined && !KEEPS.test(css) && !ADAPTS.test(css)) return null;
    const shown = seen && seen.alpha > 0 ? onWhite(seen) : undefined;
    // An image or a gradient shows as sent, and so must the color it lies on. With none under it,
    // nothing says what its text lies on.
    if (hasImage) return shown ? kept(shown, ownsInk) : null;
    if (!shown) return { declarations: [], needsInk: false };
    const shading = shadingOf(shown, dark);
    if (shading.as === 'kept') return kept(shown, ownsInk);
    const darkened = hexOf(shading.as === 'paper' ? dark.paper : shading.color);
    return {
      declarations: [['background-color', `light-dark(${css}, ${darkened})`]],
      needsInk: false,
    };
  };

  /** Notes a color scheme the message declares, in a meta or a `color-scheme`. */
  const declare = (value: string) => {
    if (scheme !== 'dark') scheme = schemeOf(value) ?? scheme;
  };

  /**
   * Notes the schemes a style sheet declares, before any of its colors are rewritten. Styles for a
   * dark scheme alone declare nothing: mail that paints for light paper and darkens a detail or
   * two would show its light colors on charcoal.
   */
  const scan = (rules: CSSRuleList) => {
    for (const rule of rules) {
      if ('style' in rule && rule.style instanceof CSSStyleDeclaration) {
        declare(rule.style.getPropertyValue('color-scheme'));
      }
      if ('cssRules' in rule && rule.cssRules instanceof CSSRuleList) scan(rule.cssRules);
    }
  };

  /** Rewrites the colors a declaration block sets, in place. */
  const adapt = (style: CSSStyleDeclaration): Adapted => {
    declare(style.getPropertyValue('color-scheme'));
    const unchanged = { changed: false, needsInk: false };
    if (!adapting()) return unchanged;
    // A shorthand that takes a variable leaves its colors unread until the page resolves them.
    const hidesColor = Array.from({ length: style.length }, (_, i) => style.item(i)).some(
      (name) => COLORED.has(name) && style.getPropertyValue(name) === '',
    );
    if (hidesColor) {
      keepsLight = true;
      return unchanged;
    }
    const set = (name: string, value: string) =>
      style.setProperty(name, value, style.getPropertyPriority(name));
    const ownsInk = !KEEPS.test(style.getPropertyValue('color').trim());
    const background = painted(
      style.getPropertyValue('background-color').trim(),
      !KEEPS.test(style.getPropertyValue('background-image').trim()),
      ownsInk,
    );
    if (background === null) {
      keepsLight = true;
      return unchanged;
    }
    for (const [name, value] of background.declarations) set(name, value);
    // On a color kept as sent, the lines are the sender's, as they wrote them for it.
    if (style.getPropertyValue('color-scheme') === 'light') {
      return { changed: true, needsInk: background.needsInk };
    }
    const lines: [string, string][] = [];
    for (const name of LINES) {
      const value = style.getPropertyValue(name).trim();
      if (KEEPS.test(value) || ADAPTS.test(value) || read(value)?.alpha === 0) continue;
      const shade = liftedOf(value);
      if (shade === null) {
        keepsLight = true;
        return unchanged;
      }
      lines.push([name, `light-dark(${value}, ${shade})`]);
    }
    for (const [name, value] of lines) set(name, value);
    return { changed: background.declarations.length + lines.length > 0, needsInk: false };
  };

  /**
   * What a legacy attribute, `<font color>` or `bgcolor`, adds to its element's style, or nothing
   * when it adds nothing. `ownsInk` says whether the element sets a text color of its own.
   */
  const attribute = (
    name: 'color' | 'background-color',
    value: string,
    ownsInk: boolean,
  ): FromAttribute | undefined => {
    if (!adapting()) return undefined;
    const css = legacyColor(value, read);
    const seen = css === undefined ? undefined : read(css);
    if (css === undefined || !seen) {
      keepsLight = true;
      return undefined;
    }
    if (seen.alpha === 0) return undefined;
    if (name === 'background-color') {
      const background = painted(css, false, ownsInk);
      if (background === null) keepsLight = true;
      return background ?? undefined;
    }
    const shade = liftedOf(css);
    if (shade === null) {
      keepsLight = true;
      return undefined;
    }
    return { declarations: [['color', `light-dark(${css}, ${shade})`]], needsInk: false };
  };

  /** An image a legacy `background` attribute paints, which says nothing of what lies on it. */
  const image = () => {
    if (adapting()) keepsLight = true;
  };

  /**
   * Whether a declaration block written as `css` could still change anything: once mail has dark
   * styles of its own or stays on light paper, only a dark scheme it declares can.
   */
  const listening = (css: string) => adapting() || (scheme !== 'dark' && /scheme/i.test(css));

  /** The paper the message sits on, once the walk is done. */
  const paper = (): Paper =>
    scheme !== 'dark' && (keepsLight || scheme === 'light') ? 'light' : 'theme';

  return { declare, scan, adapt, attribute, image, listening, paper };
}

/**
 * A rule for one color scheme, `@media (prefers-color-scheme: dark)`, rewritten to apply under the
 * frame's scheme instead, which `frameDocument` writes on its root. A frame's media follow the
 * system's scheme, never the theme the member picked, so this is how mail's own dark styles follow
 * the theme. Undefined for a rule that names no scheme, or names one in a condition too intricate
 * to rewrite, which then follows the system's.
 */
export function schemeRule(rule: CSSMediaRule): string | undefined {
  const queries = [...rule.media];
  const [query] = queries;
  if (query === undefined || queries.length > 1 || !/prefers-color-scheme/i.test(query)) {
    return undefined;
  }
  let scheme: string | undefined;
  const rest: string[] = [];
  for (const part of query.trim().split(/\s+and\s+/i)) {
    const named = SCHEME_FEATURE.exec(part)?.[1];
    if (named && !scheme) scheme = named.toLowerCase();
    else if (named || /prefers-color-scheme|^not\b|\bor\b/i.test(part)) return undefined;
    else rest.push(part);
  }
  if (!scheme) return undefined;
  const inner = [...rule.cssRules].map(({ cssText }) => cssText).join('\n');
  const scoped = `@scope (:root[${SCHEME_ATTRIBUTE}="${scheme}"]) {\n${inner}\n}`;
  return rest.length ? `@media ${rest.join(' and ')} {\n${scoped}\n}` : scoped;
}

/** The attribute on a frame's root that names its color scheme, for `schemeRule`. */
export const SCHEME_ATTRIBUTE = 'data-tm-scheme';

const SCHEME_FEATURE = /^\(\s*prefers-color-scheme\s*:\s*(dark|light)\s*\)$/i;

/**
 * A color as CSS writes it, from a legacy attribute's value. Browsers read six hex digits without
 * their `#` there too. Anything stranger, which each browser reads its own way, is undefined.
 */
function legacyColor(value: string, read: ColorReader): string | undefined {
  const trimmed = value.trim();
  if (read(trimmed)) return trimmed;
  return /^[0-9a-f]{6}$/i.test(trimmed) ? `#${trimmed}` : undefined;
}

export type ColorReader = (css: string) => Seen | undefined;

/**
 * Reads any CSS color as the browser does, by drawing it: whatever its space, it comes back as the
 * sRGB a screen shows, and how opaque it is. A value no canvas draws, such as one that depends on a
 * variable, is undefined, and so is every color past the `most` it reads.
 */
export function colorReader(most = Infinity): ColorReader {
  const context = new OffscreenCanvas(1, 1).getContext('2d', { willReadFrequently: true });
  const seen = new Map<string, Seen | undefined>();
  const draw = (css: string): Seen | undefined => {
    if (!context) return undefined;
    // A canvas ignores a fill it can't read, so one that reads keeps the same value either way.
    context.fillStyle = '#010203';
    context.fillStyle = css;
    const first = String(context.fillStyle);
    context.fillStyle = '#040506';
    context.fillStyle = css;
    if (first !== String(context.fillStyle)) return undefined;
    context.clearRect(0, 0, 1, 1);
    context.fillRect(0, 0, 1, 1);
    const [r = 0, g = 0, b = 0, alpha = 0] = context.getImageData(0, 0, 1, 1).data;
    return { rgb: { r: r / 255, g: g / 255, b: b / 255 }, alpha: alpha / 255 };
  };
  return (css) => {
    if (!seen.has(css)) seen.set(css, seen.size < most ? draw(css) : undefined);
    return seen.get(css);
  };
}

const WHITE: Rgb = { r: 1, g: 1, b: 1 };
const BLACK: Rgb = { r: 0, g: 0, b: 0 };

/** The OKLCH lightness from which a background is light, and darkens in the dark theme. */
const LIGHT = 0.8;
/** The most chroma a light background has and still darkens. More is a strong color, kept as sent. */
const TINT = 0.1;
/** How much of its chroma a darkened background keeps, so its hue shows without glaring. */
const MUTED = 0.6;

/**
 * The most distinct colors read in one message. Mail sets a few dozen. Mail that sets thousands
 * would cost a draw for each, so past this it stays on light paper instead.
 */
const MOST_COLORS = 1_000;

/** Below this chroma a color is a gray, and a gray as strong as the theme's ink becomes it. */
const NEUTRAL_CHROMA = 0.04;
