import DOMPurify from 'dompurify';
import { mailColors, schemeRule, SCHEME_ATTRIBUTE, type DarkPaper, type Paper } from './colors.ts';
import { rewriteCssResources } from './css.ts';
import { isAttribution, isForward, quoteMarker, type QuoteMarker } from './quotes.ts';

/**
 * Hostile mail, made safe to show: message HTML in, and out comes the document its frame shows.
 *
 * DOMPurify keeps HTML only, with no SVG or MathML, and drops forms, media and everything that
 * runs. Every other rewrite happens in its hooks, while it walks the message, and nothing touches
 * the result afterwards:
 * - Images load only from the message's own parts (`cid:`), from `data:`, or, once the member
 *   allows the sender, through the Worker's proxy. That covers `src`, `srcset`, `background` and
 *   every `url()` and image function in CSS, which the browser's own CSS parser normalizes first.
 * - Links open in a new tab, with no opener and no referrer, and only to http, mail and phone.
 * - A quote that ends the message is marked so the frame can fold it.
 * - The colors the message sets are rewritten to read on the dark theme's paper as well, and its
 *   styles for a color scheme follow the theme's, as `colors.ts` describes.
 *
 * The frame is a second, independent wall: a sandbox without scripts or forms, and a content
 * security policy that names exactly the images this sanitizer let through.
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
  /** The paper it sits on: the theme's, or light paper in both themes for mail that paints. */
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
    quote: false,
    inlineParts: new Set<string>(),
    sources: new Set<string>(),
  };
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
      source = images.remote?.(url.href);
      if (!source) mail.blockedImages = true;
    }
    if (!source) return null;
    mail.sources.add(source);
    return source;
  };

  const safeCss = (css: string) => rewriteCssResources(css, imageSource);
  // Inline styles as written, and as they are kept.
  const styles = new Map<string, string>();

  const adaptAttribute = (element: Element, name: 'color' | 'background-color', value: string) => {
    const css = colors.attribute(name, value);
    if (css && element instanceof HTMLElement && !element.style.getPropertyValue(name)) {
      element.style.setProperty(name, css);
    }
  };

  purify.addHook('beforeSanitizeElements', (node) => {
    if (node.nodeName === 'BODY') wrapBody(node as HTMLElement);
  });

  purify.addHook('uponSanitizeElement', (node, data) => {
    // A meta never stays, but the scheme it declares does.
    if (data.tagName === 'meta' && node instanceof Element) {
      const name = node.getAttribute('name')?.toLowerCase();
      if (name === 'color-scheme' || name === 'supported-color-schemes') {
        colors.declare(node.getAttribute('content') ?? '');
      }
    }
    if (data.tagName !== 'style') return;
    const sheet = new window.CSSStyleSheet();
    sheet.replaceSync(node.textContent ?? '');
    colors.scan(sheet.cssRules);
    keepSafeRules(sheet.cssRules, colors.adapt);
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
        const again = styles.get(value);
        if (again !== undefined) return keep(again);
        // A declaration without a `(` holds no function, so it can load nothing, and one that
        // names no color sets none. Most mail's inline styles are one or the other, and they are
        // kept as written.
        const loads = value.includes('(');
        const colored = /color|background/i.test(value) && colors.listening(value);
        if (!loads && !colored) return;
        const scratch = element.ownerDocument.createElement('div');
        scratch.setAttribute('style', value);
        const adapted = colored && colors.adapt(scratch.style);
        const rewritten = loads
          ? safeCss(scratch.style.cssText)
          : adapted
            ? scratch.style.cssText
            : value;
        styles.set(value, rewritten);
        return keep(rewritten);
      }
      case 'src':
        return keep(tag === 'img' ? imageSource(value) : null);
      case 'srcset':
        return keep(tag === 'img' || tag === 'source' ? rewriteSrcset(value, imageSource) : null);
      case 'background':
        return keep(imageSource(value));
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
    if (element.hasAttribute('href')) {
      element.setAttribute('target', '_blank');
      element.setAttribute('rel', 'noopener noreferrer');
    }
    if (folding.has(element)) {
      element.setAttribute(FOLD, '');
      return;
    }
    const marker = markerOf(element);
    if (!marker || element.parentElement?.closest(`[${FOLD}]`) || !foldable(element, marker)) {
      return;
    }
    element.setAttribute(FOLD, '');
    mail.quote = true;
    if (marker === 'rest') {
      for (let next = element.nextElementSibling; next; next = next.nextElementSibling) {
        folding.add(next);
      }
    }
    const attribution = previousMeaningful(element);
    if (attribution && isAttribution(attribution.textContent ?? '')) {
      attribution.setAttribute(FOLD, '');
    }
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
    paper: colors.paper(),
    quote: mail.quote,
    inlineParts: [...mail.inlineParts],
    sources: [...mail.sources],
  };
}

/** How the frame looks: values resolved from the reader's theme, never from the message. */
export type FrameLook = {
  colorScheme: 'light' | 'dark';
  paper: string;
  ink: string;
  link: string;
  font: string;
  monospace: string;
  quotes: 'folded' | 'shown';
};

/**
 * The document a message's frame shows, under its own content security policy, in the parts it is
 * written in. Long mail comes in two: its start, with the head, which is laid out and shown at once,
 * and the rest, written once the member stays on it. Short mail is all `start`.
 */
export type FrameDocument = { start: string; rest: string };

/** How much of long mail is written first: several screens of most mail, a few kilobytes of it. */
export const FIRST_PART = 32_000;

export function frameDocument(mail: SafeMail, look: FrameLook): FrameDocument {
  const images = ['data:', ...new Set(mail.sources.map(cspSource).filter(Boolean))];
  const policy = [
    "default-src 'none'",
    `img-src ${images.join(' ')}`,
    "style-src 'unsafe-inline'",
    'font-src data:',
    "form-action 'none'",
    "base-uri 'none'",
  ].join('; ');
  const style = frameStyle(look);
  const head = `<!doctype html><html ${SCHEME_ATTRIBUTE}="${look.colorScheme}"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${escapeAttribute(policy)}"><meta name="referrer" content="no-referrer"><base target="_blank"><style>${style}</style></head><body>`;
  const end = '</body></html>';
  const cut = cutOf(mail.html);
  return cut === undefined
    ? { start: head + mail.html + end, rest: '' }
    : { start: head + mail.html.slice(0, cut), rest: mail.html.slice(cut) + end };
}

/**
 * Where long mail is cut in two: at the first tag past its first part and past every style it sets,
 * so what shows first is styled as it will stay. Mail that is short, or whose styles come late, is
 * not cut, and the whole of it is the start.
 */
function cutOf(html: string): number | undefined {
  if (html.length < FIRST_PART * 2) return undefined;
  const styled = html.toLowerCase().lastIndexOf('</style');
  const cut = html.indexOf('<', Math.max(FIRST_PART, styled + 1));
  return cut > 0 && cut < html.length * 0.75 ? cut : undefined;
}

const FOLD = 'data-tm-quote';
const FORMS = ['form', 'input', 'button', 'select', 'option', 'optgroup', 'textarea', 'datalist'];
const POPOVERS = ['popover', 'popovertarget', 'popovertargetaction', 'command', 'commandfor'];

/**
 * Drops the rules that load something no image rewrite can make safe: fonts, and counter styles
 * and registered properties, whose images CSS reaches without `url()` in a value. Every rule kept
 * has its colors adapted, and a rule for one color scheme is rewritten to follow the frame's.
 */
function keepSafeRules(rules: CSSRuleList, adapt: (style: CSSStyleDeclaration) => void) {
  for (let i = rules.length - 1; i >= 0; i--) {
    const rule = rules[i];
    if (!rule) continue;
    const name = rule.constructor.name;
    if (
      name === 'CSSFontFaceRule' ||
      name === 'CSSCounterStyleRule' ||
      name === 'CSSPropertyRule'
    ) {
      deleteRule(rule, i);
      continue;
    }
    if ('style' in rule && rule.style instanceof CSSStyleDeclaration) adapt(rule.style);
    if ('cssRules' in rule && rule.cssRules instanceof CSSRuleList) {
      keepSafeRules(rule.cssRules, adapt);
    }
    const themed = name === 'CSSMediaRule' ? schemeRule(rule as CSSMediaRule) : undefined;
    if (themed) replaceRule(rule, i, themed);
  }
}

function deleteRule(rule: CSSRule, index: number) {
  const parent = rule.parentRule ?? rule.parentStyleSheet;
  if (parent && 'deleteRule' in parent) parent.deleteRule(index);
}

/** Puts `text` in the place of a rule, or leaves the rule as it is where a browser can't read it. */
function replaceRule(rule: CSSRule, index: number, text: string) {
  const parent = rule.parentRule ?? rule.parentStyleSheet;
  if (!parent || !('insertRule' in parent)) return;
  try {
    parent.insertRule(text, index);
  } catch {
    return;
  }
  parent.deleteRule(index + 1);
}

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

function markerOf(element: Element): QuoteMarker | null {
  const marker = quoteMarker({
    tag: element.localName,
    id: element.id,
    className: element.getAttribute('class') ?? '',
    type: element.getAttribute('type') ?? '',
  });
  if (marker) return marker;
  // Outlook's desktop app opens its quoted original with a ruled header block and no marker.
  const style = element.getAttribute('style') ?? '';
  if (style.includes('border') && element instanceof HTMLDivElement) {
    if (element.style.borderTopStyle !== 'solid') return null;
    if (isAttribution(leadingText(element))) return 'rest';
  }
  return null;
}

/** A quote folds when the writer said something before it, and nothing of theirs follows it. */
function foldable(element: Element, marker: QuoteMarker): boolean {
  if (isForward(leadingText(element))) return false;
  if (!hasText(element, 'before')) return false;
  return marker === 'rest' || !hasText(element, 'after');
}

/** Whether the writer's own words, outside any quote, come before or after `element`. */
function hasText(element: Element, direction: 'before' | 'after'): boolean {
  const document = element.ownerDocument;
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  walker.currentNode = element;
  const step = () => (direction === 'before' ? walker.previousNode() : walker.nextNode());
  for (let node = step(); node; node = step()) {
    if (element.contains(node) || !node.textContent?.trim()) continue;
    const parent = node.parentElement;
    if (!parent || parent.closest('style, title, template')) continue;
    if (insideQuote(parent)) continue;
    return true;
  }
  return false;
}

function insideQuote(element: Element): boolean {
  for (let at: Element | null = element; at; at = at.parentElement) {
    if (at.hasAttribute(FOLD) || markerOf(at)) return true;
  }
  return false;
}

/**
 * The element just before `element` that holds text, looking past wrappers that hold nothing else,
 * as an attribution sits just before the quote it introduces.
 */
function previousMeaningful(element: Element): Element | null {
  let at: Element | null = element;
  for (let level = 0; at && level < 3 && at.localName !== 'body'; level++) {
    for (
      let sibling = at.previousElementSibling;
      sibling;
      sibling = sibling.previousElementSibling
    ) {
      if (sibling.textContent?.trim()) return sibling;
    }
    const parent: Element | null = at.parentElement;
    if (!parent || parent.textContent?.trim() !== at.textContent?.trim()) return null;
    at = parent;
  }
  return null;
}

/** The first few hundred characters of text inside `element`, without reading all of it. */
function leadingText(element: Element, length = 400): string {
  const walker = element.ownerDocument.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  let text = '';
  for (let node = walker.nextNode(); node && text.length < length; node = walker.nextNode()) {
    text += `${node.textContent ?? ''} `;
  }
  return text.slice(0, length);
}

function linkTarget(raw: string): string | null {
  const url = parseUrl(raw);
  return url && LINK_PROTOCOLS.has(url.protocol) ? url.href : null;
}

const LINK_PROTOCOLS = new Set(['http:', 'https:', 'mailto:', 'tel:']);

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

/** Rewrites each candidate of a `srcset`, keeping only those that resolve. */
function rewriteSrcset(value: string, resolve: (url: string) => string | null): string | null {
  const candidates: string[] = [];
  for (const { url, descriptor } of parseSrcset(value)) {
    const source = resolve(url);
    if (source) candidates.push(descriptor ? `${source} ${descriptor}` : source);
  }
  return candidates.length ? candidates.join(', ') : null;
}

/**
 * The candidates of a `srcset`, split as the HTML standard splits them. A candidate a browser would
 * drop is dropped, and the one descriptor kept must match the standard's grammar whole, so no text
 * after a URL can carry another candidate.
 */
function parseSrcset(value: string): { url: string; descriptor: string }[] {
  const candidates: { url: string; descriptor: string }[] = [];
  let i = 0;
  while (i < value.length) {
    while (i < value.length && /[\t\n\f\r ,]/.test(value[i] ?? '')) i++;
    if (i >= value.length) break;
    const start = i;
    while (i < value.length && !isHtmlSpace(value[i] ?? '')) i++;
    let url = value.slice(start, i);
    const descriptors: string[] = [];
    if (url.endsWith(',')) {
      url = url.replace(/,+$/, '');
    } else {
      // The standard's descriptor tokenizer: a `(` holds commas and spaces until the next `)`,
      // and parentheses don't nest.
      let state: 'descriptor' | 'parens' | 'after' = 'descriptor';
      let current = '';
      for (; ; i++) {
        const c = value[i];
        if (state === 'parens') {
          if (c === undefined) {
            descriptors.push(current);
            break;
          }
          current += c;
          if (c === ')') state = 'descriptor';
        } else if (state === 'after') {
          if (c === undefined) break;
          if (!isHtmlSpace(c)) {
            state = 'descriptor';
            i--;
          }
        } else if (c === undefined || c === ',') {
          if (current) descriptors.push(current);
          if (c === ',') i++;
          break;
        } else if (isHtmlSpace(c)) {
          if (current) descriptors.push(current);
          current = '';
          state = 'after';
        } else {
          current += c;
          if (c === '(') state = 'parens';
        }
      }
    }
    const descriptor = srcsetDescriptor(descriptors);
    if (descriptor !== null) candidates.push({ url, descriptor });
  }
  return candidates;
}

/**
 * A candidate's descriptors as one a browser would use: a width, a density or none. Null when a
 * browser would drop the candidate. A height is valid only beside a width, and browsers ignore it.
 */
function srcsetDescriptor(descriptors: string[]): string | null {
  let width: string | undefined;
  let density: string | undefined;
  let height: string | undefined;
  for (const descriptor of descriptors) {
    const [, number = '', kind] = /^(.*)([wxh])$/.exec(descriptor) ?? [];
    const count = /^[0-9]+$/.test(number) ? Number(number) : 0;
    const float = /^-?(?:[0-9]+(?:\.[0-9]+)?|\.[0-9]+)(?:[eE][-+]?[0-9]+)?$/.test(number);
    if (kind === 'w' && count > 0 && !width && !density) width = descriptor;
    else if (kind === 'x' && float && Number(number) >= 0 && !width && !density && !height) {
      density = descriptor;
    } else if (kind === 'h' && count > 0 && !height && !density) height = descriptor;
    else return null;
  }
  if (height && !width) return null;
  return width ?? density ?? '';
}

/** ASCII whitespace, as HTML defines it. */
const isHtmlSpace = (c: string) =>
  c === ' ' || c === '\t' || c === '\n' || c === '\f' || c === '\r';

/** An image URL as a content security policy source: its origin and path. */
function cspSource(url: string): string {
  const parsed = URL.parse(url);
  if (!parsed) return '';
  const path = parsed.pathname.replace(/[;,\s']/g, (c) => `%${c.charCodeAt(0).toString(16)}`);
  return `${parsed.origin}${path}`;
}

function frameStyle(look: FrameLook): string {
  const value = (css: string) => css.replace(/[<>{};]/g, '');
  return `:root{color-scheme:${look.colorScheme};background:${value(look.paper)};color:${value(look.ink)};font:${value(look.font)};overflow-wrap:break-word;-webkit-text-size-adjust:100%}
:root:not(#tm),body:not(#tm){height:auto!important;min-height:0!important}
body{margin:0}
a{color:${value(look.link)}}
img{max-width:100%;height:auto}
pre,code,kbd,samp,tt{font-family:${value(look.monospace)}}
pre{white-space:pre-wrap}
blockquote[type=cite]{margin:0 0 0 .8ex;padding-left:1ex;border-left:2px solid color-mix(in oklab,currentcolor 25%,transparent)}
${look.quotes === 'folded' ? `[${FOLD}]{display:none!important}` : ''}`;
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}
