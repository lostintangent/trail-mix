import { contrast, hexOf, oklchOf, over, readableShade, type Rgb } from '../../../shared/color.ts';

/**
 * Mail's own colors on the theme's paper.
 *
 * Mail is written for white paper. In the dark theme it sits on charcoal instead, and each color
 * it sets on text or a line is lifted to read there: its hue kept, and lightened until it reads as
 * strongly as it did on white, and at least 4.5:1. Black and near-black become the theme's ink.
 * A white background is only the sender's paper, and gives way to the theme's.
 *
 * Three kinds of mail are left as they are. Mail that declares a dark color scheme shows its own
 * dark styles. Mail that paints backgrounds of its own, asks for light only, or sets a color no
 * browser reads the same way stays on light paper in both themes.
 *
 * Each color is rewritten as `light-dark(original, lifted)`, so one sanitized message serves both
 * themes, and its frame's color scheme picks between them.
 */

/** The dark theme's paper, and the ink written on it. */
export type DarkPaper = { paper: Rgb; ink: Rgb };

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

/**
 * What a walk through a message learns about its colors, and the rewrites that let them read on
 * the dark theme's paper. Declarations and attributes are handed to it as the walk meets them.
 */
export function mailColors(dark: DarkPaper) {
  const read = colorReader(MOST_COLORS);
  const lifted = new Map<string, string | null>();
  let scheme: 'dark' | 'light' | undefined;
  let keepsLight = false;

  // A rewrite matters only for mail that declares no scheme of its own, and not on light paper.
  const adapting = () => scheme === undefined && !keepsLight;

  /** The dark side of `light-dark()` for a color on text or a line, or null for one unread. */
  const liftedOf = (css: string): string | null => {
    let shade = lifted.get(css);
    if (shade === undefined) {
      const seen = read(css);
      shade = seen ? hexOf(liftedColor(onWhite(seen), dark)) : null;
      lifted.set(css, shade);
    }
    return shade;
  };

  /** The dark side for a background: none where it is white paper, or null where it paints. */
  const backgroundOf = (seen: Seen | undefined): string | null =>
    seen && (seen.alpha === 0 || isPaperWhite(onWhite(seen))) ? 'transparent' : null;

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

  /** Rewrites the colors a declaration block sets, in place. Returns whether it changed any. */
  const adapt = (style: CSSStyleDeclaration): boolean => {
    declare(style.getPropertyValue('color-scheme'));
    if (!adapting()) return false;
    let changed = false;
    const set = (name: string, value: string) => {
      style.setProperty(name, value, style.getPropertyPriority(name));
      changed = true;
    };
    if (!KEEPS.test(style.getPropertyValue('background-image').trim())) {
      keepsLight = true;
      return changed;
    }
    const background = style.getPropertyValue('background-color').trim();
    if (!KEEPS.test(background) && !ADAPTS.test(background)) {
      const paper = backgroundOf(read(background));
      if (paper === null) {
        keepsLight = true;
        return changed;
      }
      set('background-color', `light-dark(${background}, ${paper})`);
    }
    for (const name of LINES) {
      const value = style.getPropertyValue(name).trim();
      if (KEEPS.test(value) || ADAPTS.test(value) || read(value)?.alpha === 0) continue;
      const shade = liftedOf(value);
      if (shade === null) {
        keepsLight = true;
        return changed;
      }
      set(name, `light-dark(${value}, ${shade})`);
    }
    return changed;
  };

  /**
   * The color a legacy attribute sets, `<font color>` or `bgcolor`, as a value for the same
   * property in the element's style, or undefined when it needs none.
   */
  const attribute = (name: 'color' | 'background-color', value: string): string | undefined => {
    if (!adapting()) return undefined;
    const css = legacyColor(value, read);
    const seen = css === undefined ? undefined : read(css);
    if (css === undefined || !seen) {
      keepsLight = true;
      return undefined;
    }
    if (seen.alpha === 0) return undefined;
    const shade = name === 'color' ? liftedOf(css) : backgroundOf(seen);
    if (shade === null) {
      keepsLight = true;
      return undefined;
    }
    return `light-dark(${css}, ${shade})`;
  };

  /**
   * Whether a declaration block written as `css` could still change anything: once mail has dark
   * styles of its own or stays on light paper, only a dark scheme it declares can.
   */
  const listening = (css: string) => adapting() || (scheme !== 'dark' && /scheme/i.test(css));

  /** The paper the message sits on, once the walk is done. */
  const paper = (): Paper =>
    scheme !== 'dark' && (keepsLight || scheme === 'light') ? 'light' : 'theme';

  return { declare, scan, adapt, attribute, listening, paper };
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

/**
 * The most distinct colors read in one message. Mail sets a few dozen. Mail that sets thousands
 * would cost a draw for each, so past this it stays on light paper instead.
 */
const MOST_COLORS = 1_000;

/** Below this chroma a color is a gray, and a gray as strong as the theme's ink becomes it. */
const NEUTRAL_CHROMA = 0.04;
