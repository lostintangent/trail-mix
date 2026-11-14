import { SCHEME_ATTRIBUTE } from './colors.ts';

/**
 * The document a message's frame shows: the sanitized markup on the reader's theme, under a
 * content security policy that names exactly the images the sanitizer let through. The frame draws
 * the marks the sanitizer leaves on the markup: the quote that folds, text that takes the light
 * theme's ink, and an image held back.
 */

/** How the frame looks: values resolved from the reader's theme, never from the message. */
export type FrameLook = {
  colorScheme: 'light' | 'dark';
  paper: string;
  ink: string;
  link: string;
  /** The light theme's ink and links, for what lies on mail's own light colors in the dark theme. */
  lightInk: string;
  lightLink: string;
  font: string;
  monospace: string;
  quotes: 'folded' | 'shown';
};

/**
 * The frame's document in the parts it is written in. Long mail comes in two: its start, with the
 * head, which is laid out and shown at once, and the rest, written once the member stays on it.
 * Short mail is all `start`.
 */
type FrameDocument = { start: string; rest: string };

/** How much of long mail is written first: several screens of most mail, a few kilobytes of it. */
export const FIRST_PART = 32_000;

export function frameDocument(
  mail: { html: string; sources: readonly string[] },
  look: FrameLook,
): FrameDocument {
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

/** Marks the quote that ends a message, and its attribution, which fold while quotes are folded. */
export const FOLD = 'data-tm-quote';
/** Marks an element whose text takes the light theme's ink in the dark theme, as its frame says. */
export const INK = 'data-tm-ink';
/** Marks an image held back until the member allows its sender's images, as its frame draws it. */
export const HELD = 'data-tm-held';

/** An image URL as a content security policy source: its origin and path. */
function cspSource(url: string): string {
  const parsed = URL.parse(url);
  if (!parsed) return '';
  const path = parsed.pathname.replace(/[;,\s']/g, (c) => `%${c.charCodeAt(0).toString(16)}`);
  return `${parsed.origin}${path}`;
}

function frameStyle(look: FrameLook): string {
  const value = (css: string) => css.replace(/[<>{};]/g, '');
  // In the dark theme, what lies on a color the message keeps as sent is in the light scheme, so
  // links there take the light theme's color, and marked text its ink.
  const onKept =
    look.colorScheme === 'dark'
      ? `a{color:light-dark(${value(look.lightLink)},${value(look.link)})}
:where([${INK}]){color:${value(look.lightInk)}}`
      : `a{color:${value(look.link)}}`;
  return `:root{color-scheme:${look.colorScheme};background:${value(look.paper)};color:${value(look.ink)};font:${value(look.font)};overflow-wrap:break-word;-webkit-text-size-adjust:100%}
:root:not(#tm),body:not(#tm){height:auto!important;min-height:0!important}
body{margin:0}
${onKept}
img{max-width:100%;height:auto}
img[${HELD}]{background:color-mix(in oklab,currentcolor 8%,transparent) url("${HELD_ICON}") center/min(20px,80%) no-repeat;border-radius:4px}
img[${HELD}]:not([width]):not([height]){vertical-align:middle}
pre,code,kbd,samp,tt{font-family:${value(look.monospace)}}
pre{white-space:pre-wrap}
blockquote[type=cite]{margin:0 0 0 .8ex;padding-left:1ex;border-left:2px solid color-mix(in oklab,currentcolor 25%,transparent)}
${look.quotes === 'folded' ? `[${FOLD}]{display:none!important}` : ''}`;
}

/** A small picture's outline, centered on a held image: something is here, held back. */
const HELD_ICON = `data:image/svg+xml,${encodeURIComponent(
  "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='#8a8f98' stroke-width='1.75' stroke-linecap='round' stroke-linejoin='round'><rect width='18' height='18' x='3' y='3' rx='2'/><circle cx='9' cy='9' r='2'/><path d='m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21'/></svg>",
)}`;

function escapeAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}
