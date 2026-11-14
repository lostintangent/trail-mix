import DOMPurify from 'dompurify';
import { hexOf } from '../../../shared/color.ts';
import { mailColors, type Adapted, type DarkPaper, type Paper } from './colors.ts';
import { keepSafeRules, rewriteCssResources } from './css.ts';
import { FOLD, HELD, INK } from './frame.ts';
import { foldingQuote } from './quotes.ts';
import { parseSrcset, rewriteSrcset } from './srcset.ts';
import { isTrackingAddress, unseenImages } from './trackers.ts';

/**
 * Hostile mail, made safe to show: message HTML in, and out comes the document its frame shows.
 *
 * DOMPurify keeps HTML only, with no SVG or MathML, and drops forms, media and everything that
 * runs. Every other rewrite happens in its hooks, while it walks the message, and nothing touches
 * the result afterwards:
 * - Images load only from the message's own parts (`cid:`), from `data:`, or, once the member
 *   allows the sender, through the Worker's proxy. That covers `src`, `srcset`, `background` and
 *   every `url()` and image function in CSS, which the browser's own CSS parser normalizes first.
 * - Tracking pixels never load, as `trackers.ts` describes, and are counted.
 * - Links open in a new tab, with no opener and no referrer, and only to http, mail and phone.
 * - A quote that ends the message is marked so the frame can fold it.
 * - The colors the message sets are rewritten to read on the dark theme's paper as well, and its
 *   styles for a color scheme follow the theme's, as `colors.ts` describes. Text on a light color
 *   kept as sent is marked, or given a rule, to take the light theme's ink in the dark theme.
 *
 * The frame is a second, independent wall: a sandbox without scripts or forms, and a content
 * security policy that names exactly the images this sanitizer let through, as `frame.ts` writes.
 */

/** Where a message's images may load from. */
export type Images = {
  /** The URL of the message's own part with this Content-ID, if it has one. */
  part: (contentId: string) => string | undefined;
  /** Where a remote image loads once its sender is allowed: the Worker's proxy. Absent until then. */
  remote?: (url: string) => string;
};

export type SafeMail = {
  /** The message's markup, safe inside the body of `frameDocument` and nowhere else. */
  html: string;
  /** Remote images were left out, because the sender is not allowed yet. */
  blockedImages: boolean;
  /** How many tracking pixels were left out, whether or not the sender is allowed. */
  trackers: number;
  /**
   * The paper it sits on: the theme's, or light paper in both themes for mail whose colors can't be
   * darkened. A member may choose light paper for a sender's mail besides.
   */
  paper: Paper;
  /** A quote ends the message and is marked to fold. */
  quote: boolean;
  /** The Content-IDs shown inline, which the list of attachments leaves out. */
  inlineParts: string[];
  /** Every URL an image may load from, apart from `data:`. */
  sources: string[];
};

export function sanitizeMail(html: string, images: Images, dark: DarkPaper): SafeMail {
  const purify = DOMPurify(window);
  const colors = mailColors(dark);
  const mail = {
    blockedImages: false,
    // Their addresses, so a pixel the message repeats counts once.
    trackers: new Set<string>(),
    quote: false,
    inlineParts: new Set<string>(),
    sources: new Set<string>(),
  };
  // The message's style sheets as it wrote them, for what decides whether an image is ever seen.
  const written = new WeakMap<Element, string>();
  const unseen = unseenImages((document) =>
    [...document.querySelectorAll('style')].map(
      (style) => written.get(style) ?? style.textContent ?? '',
    ),
  );
  // Elements that follow an Outlook-style marker, to be marked when the walk reaches them.
  const folding = new WeakSet<Node>();

  const imageSource = (raw: string): string | null => {
    const url = parseUrl(raw);
    if (!url) return null;
    let source: string | undefined;
    if (url.protocol === 'cid:') {
      const contentId = contentIdOf(url);
      source = images.part(contentId);
      if (source) mail.inlineParts.add(contentId);
    } else if (url.protocol === 'data:') {
      // The frame's policy allows every `data:` image, so these need no source of their own.
      return /^data:image\//i.test(url.href) ? url.href : null;
    } else if (url.protocol === 'http:' || url.protocol === 'https:') {
      if (isTrackingAddress(url)) {
        mail.trackers.add(url.href);
        return null;
      }
      source = images.remote?.(url.href);
      if (!source) mail.blockedImages = true;
    }
    if (!source) return null;
    mail.sources.add(source);
    return source;
  };

  const safeCss = (css: string) => rewriteCssResources(css, imageSource);
  // Inline styles as written, and as they are kept.
  const styles = new Map<string, { rewritten: string; needsInk: boolean }>();
  // Elements whose text takes the light theme's ink in the dark theme, marked once they're walked.
  const inked = new WeakSet<Element>();
  // Images whose source is held back until the member allows the sender's images.
  const held = new WeakSet<Element>();
  const lightInk = hexOf(dark.lightInk);

  const adaptAttribute = (element: Element, name: 'color' | 'background-color', value: string) => {
    if (!(element instanceof HTMLElement) || element.style.getPropertyValue(name)) return;
    const ownsInk = element.style.getPropertyValue('color') !== '';
    const added = colors.attribute(name, value, ownsInk);
    for (const [property, css] of added?.declarations ?? []) {
      if (!element.style.getPropertyValue(property)) element.style.setProperty(property, css);
    }
    if (added?.needsInk) inked.add(element);
  };

  purify.addHook('beforeSanitizeElements', (node) => {
    if (node.nodeName === 'BODY') wrapBody(node as HTMLElement);
  });

  purify.addHook('uponSanitizeElement', (node, data) => {
    // A tracking pixel goes whole, so nothing holds its place.
    if (data.tagName === 'img' && node instanceof HTMLElement) {
      const address = remoteAddress(node);
      if (address && (isTrackingAddress(address) || unseen(node))) {
        mail.trackers.add(address.href);
        node.remove();
      }
      return;
    }
    // A meta never stays, but the scheme it declares does.
    if (data.tagName === 'meta' && node instanceof Element) {
      const name = node.getAttribute('name')?.toLowerCase();
      if (name === 'color-scheme' || name === 'supported-color-schemes') {
        colors.declare(node.getAttribute('content') ?? '');
      }
    }
    if (data.tagName !== 'style') return;
    written.set(node as Element, node.textContent ?? '');
    const sheet = new window.CSSStyleSheet();
    sheet.replaceSync(node.textContent ?? '');
    colors.scan(sheet.cssRules);
    keepSafeRules(sheet.cssRules, colors.adapt, lightInk);
    node.textContent = safeCss([...sheet.cssRules].map((rule) => rule.cssText).join('\n'));
  });

  purify.addHook('uponSanitizeAttribute', (element, data) => {
    const tag = element.localName;
    const value = data.attrValue;
    const keep = (rewritten: string | null) => {
      if (rewritten === null) data.keepAttr = false;
      else data.attrValue = rewritten;
    };
    switch (data.attrName) {
      case 'style': {
        // Mail repeats the same style on line after line, and it comes out the same each time.
        let kept = styles.get(value);
        if (kept === undefined) {
          // A declaration without a `(` holds no function, so it can load nothing, and one that
          // names no color sets none. Most mail's inline styles are one or the other, and they are
          // kept as written.
          const loads = value.includes('(');
          const colored = /color|background/i.test(value) && colors.listening(value);
          if (!loads && !colored) return;
          const scratch = element.ownerDocument.createElement('div');
          scratch.setAttribute('style', value);
          const adapted: Adapted = colored
            ? colors.adapt(scratch.style)
            : { changed: false, needsInk: false };
          const rewritten = loads
            ? safeCss(scratch.style.cssText)
            : adapted.changed
              ? scratch.style.cssText
              : value;
          kept = { rewritten, needsInk: adapted.needsInk };
          styles.set(value, kept);
        }
        if (kept.needsInk) inked.add(element);
        return keep(kept.rewritten);
      }
      case 'src': {
        if (tag !== 'img') return keep(null);
        const source = imageSource(value);
        if (source === null && /^\s*https?:/i.test(value)) held.add(element);
        return keep(source);
      }
      case 'srcset':
        return keep(tag === 'img' || tag === 'source' ? rewriteSrcset(value, imageSource) : null);
      case 'background': {
        const source = imageSource(value);
        if (source) colors.image();
        return keep(source);
      }
      case 'href':
        return keep(tag === 'a' || tag === 'area' ? linkTarget(value) : null);
      default:
        // Only the sanitizer marks what folds.
        if (data.attrName.startsWith('data-tm-')) data.keepAttr = false;
    }
  });

  purify.addHook('afterSanitizeAttributes', (element) => {
    // Legacy color attributes take no `light-dark()`, so the element's style carries it instead.
    const bgcolor = element.getAttribute('bgcolor');
    if (bgcolor !== null) adaptAttribute(element, 'background-color', bgcolor);
    const color = element.localName === 'font' ? element.getAttribute('color') : null;
    if (color !== null) adaptAttribute(element, 'color', color);
    if (inked.has(element)) element.setAttribute(INK, '');
    // An image held back keeps its place, drawn quietly, unless a source of its own still loads.
    if (held.has(element) && !element.hasAttribute('src') && !element.hasAttribute('srcset')) {
      element.setAttribute('src', heldImage(element));
      element.setAttribute(HELD, '');
    }
    if (element.hasAttribute('href')) {
      element.setAttribute('target', '_blank');
      element.setAttribute('rel', 'noopener noreferrer');
    }
    if (folding.has(element)) {
      element.setAttribute(FOLD, '');
      return;
    }
    const quote = foldingQuote(element);
    if (!quote) return;
    element.setAttribute(FOLD, '');
    mail.quote = true;
    if (quote.marker === 'rest') {
      for (let next = element.nextElementSibling; next; next = next.nextElementSibling) {
        folding.add(next);
      }
    }
    quote.attribution?.setAttribute(FOLD, '');
  });

  const markup = purify.sanitize(html, {
    USE_PROFILES: { html: true },
    // A whole message's <head> styles land in the body, which is what gets sanitized and kept.
    FORCE_BODY: true,
    FORBID_TAGS: [...FORMS, 'video', 'audio', 'track'],
    FORBID_ATTR: ['action', 'formaction', 'ping', 'loading', 'poster', 'download', ...POPOVERS],
  });

  return {
    html: markup,
    blockedImages: mail.blockedImages,
    trackers: mail.trackers.size,
    paper: colors.paper(),
    quote: mail.quote,
    inlineParts: [...mail.inlineParts],
    sources: [...mail.sources],
  };
}

const FORMS = ['form', 'input', 'button', 'select', 'option', 'optgroup', 'textarea', 'datalist'];
const POPOVERS = ['popover', 'popovertarget', 'popovertargetaction', 'command', 'commandfor'];

/**
 * Moves the message's body into a div that carries its attributes. Only the body's contents are
 * kept, so this is how a `bgcolor` or `style` set on `<body>` survives, sanitized like any other.
 */
function wrapBody(body: HTMLElement) {
  const wrapper = body.ownerDocument.createElement('div');
  for (const { name, value } of [...body.attributes]) wrapper.setAttribute(name, value);
  const bgcolor = body.getAttribute('bgcolor');
  if (bgcolor && !wrapper.style.backgroundColor) wrapper.style.backgroundColor = bgcolor;
  const text = body.getAttribute('text');
  if (text && !wrapper.style.color) wrapper.style.color = text;
  const background = body.getAttribute('background');
  if (background && !wrapper.style.backgroundImage) {
    wrapper.style.backgroundImage = `url(${JSON.stringify(background)})`;
  }
  for (const { name } of [...body.attributes]) body.removeAttribute(name);
  while (body.firstChild) wrapper.appendChild(body.firstChild);
  body.appendChild(wrapper);
}

function linkTarget(raw: string): string | null {
  const url = parseUrl(raw);
  return url && LINK_PROTOCOLS.has(url.protocol) ? url.href : null;
}

const LINK_PROTOCOLS = new Set(['http:', 'https:', 'mailto:', 'tel:']);

/** Where an image would load from a server, by its `src` or else its `srcset`, if it would. */
function remoteAddress(image: Element): URL | null {
  const remote = (url: URL | null) =>
    url?.protocol === 'http:' || url?.protocol === 'https:' ? url : null;
  return (
    remote(parseUrl(image.getAttribute('src') ?? '')) ??
    parseSrcset(image.getAttribute('srcset') ?? '')
      .map(({ url }) => remote(parseUrl(url)))
      .find((url) => url !== null) ??
    null
  );
}

/** A URL as a browser reads it. Mail has no base, so a relative URL is no URL. */
function parseUrl(raw: string): URL | null {
  const value = raw.replace(/[\t\n\r]/g, '').trim();
  return URL.parse(value.startsWith('//') ? `https:${value}` : value);
}

/** `cid:` URLs percent-encode the Content-ID, which a part's header writes in angle brackets. */
function contentIdOf(url: URL): string {
  let id = url.href.slice('cid:'.length);
  try {
    id = decodeURIComponent(id);
  } catch {
    // Keep it as written.
  }
  return id.replace(/^<|>$/g, '');
}

/**
 * What a held image shows instead of its source: an empty picture as large as its attributes say
 * the source is, so it keeps its place and its proportions, and the browser draws no broken image
 * over it. One whose attributes give one side takes three times as wide as tall, and one with none
 * a small square, as an icon in a line of text would be.
 */
function heldImage(image: Element): string {
  const side = (name: string) => {
    const value = /^\s*(\d+)\s*(px)?\s*$/i.exec(image.getAttribute(name) ?? '')?.[1];
    const pixels = value === undefined ? undefined : Number(value);
    return pixels !== undefined && pixels > 0 && pixels <= 10_000 ? pixels : undefined;
  };
  const [width, height] = [side('width'), side('height')];
  const sized = image.hasAttribute('width') || image.hasAttribute('height');
  const [w, h] =
    width && height
      ? [width, height]
      : width
        ? [width, Math.ceil(width / 3)]
        : height
          ? [height * 3, height]
          : sized
            ? [300, 100]
            : [20, 20];
  return `data:image/svg+xml,${encodeURIComponent(`<svg xmlns='http://www.w3.org/2000/svg' width='${w}' height='${h}'/>`)}`;
}
