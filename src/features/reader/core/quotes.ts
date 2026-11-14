import { FOLD } from './frame.ts';

/**
 * Where a message stops being its writer's own words and starts quoting the conversation it
 * replies to. Only a quote that runs to the end of the message folds: replies written between
 * quoted lines stay as they are, and so does a message that is nothing but a quote or a forward.
 *
 * Plain text is folded here whole. HTML is folded as the sanitizer walks it, which asks
 * `foldingQuote` about each element it visits.
 */

/** Plain text split at its trailing quote. `quote` is empty when nothing folds. */
type FoldedText = { text: string; quote: string };

export function foldQuote(text: string): FoldedText {
  const lines = text.split(/\r\n|\r|\n/);
  const start = trailingQuoteStart(lines);
  if (start === null || !lines.slice(0, start).some(isMeaningful)) return { text, quote: '' };
  return {
    text: trimTrailingBlankLines(lines.slice(0, start)).join('\n'),
    quote: lines.slice(start).join('\n'),
  };
}

/**
 * How an HTML element marks quoted text: `quote` folds the element itself, and `rest` folds it
 * and everything after it, as Outlook writes a reply above an unindented original.
 */
export type QuoteMarker = 'quote' | 'rest';

type ElementTraits = { tag: string; id: string; className: string; type: string };

export function quoteMarker({ tag, id, className, type }: ElementTraits): QuoteMarker | null {
  if (REST_IDS.has(id.replace(/^x_/, ''))) return 'rest';
  if (tag === 'blockquote' && type.toLowerCase() === 'cite') return 'quote';
  if (QUOTE_IDS.has(id.replace(/^x_/, ''))) return 'quote';
  const classes = className.split(/\s+/).map((name) => name.replace(/^x_/, ''));
  return classes.some((name) => QUOTE_CLASSES.has(name)) ? 'quote' : null;
}

/** The line that introduces a quote: "On Monday, Ada wrote:", or Outlook's From and Sent. */
export function isAttribution(text: string): boolean {
  const line = text.replace(/\s+/g, ' ').trim();
  if (line.length > 400) return false;
  return WROTE.test(line) || isHeaderBlock(line);
}

/** A forward is the point of its message, so it never folds. */
function isForward(text: string): boolean {
  return FORWARD.test(text.slice(0, 400));
}

/**
 * How `element` folds as the quote that ends its message: itself, or, as `rest`, with everything
 * after it, and with the attribution that introduces it. Null when it isn't such a quote, or lies
 * inside one already marked to fold.
 */
export function foldingQuote(
  element: Element,
): { marker: QuoteMarker; attribution: Element | undefined } | null {
  const marker = markerOf(element);
  if (!marker || element.parentElement?.closest(`[${FOLD}]`) || !foldable(element, marker)) {
    return null;
  }
  const before = previousMeaningful(element);
  const attribution = before && isAttribution(before.textContent ?? '') ? before : undefined;
  return { marker, attribution };
}

// Gmail, Apple Mail, Thunderbird, Proton, Yahoo, Zoho and Outlook, including the `x_` prefix that
// Outlook adds to the classes and ids of mail it quotes.
const QUOTE_CLASSES = new Set([
  'gmail_quote',
  'gmail_quote_container',
  'gmail_attr',
  'moz-cite-prefix',
  'protonmail_quote',
  'yahoo_quoted',
  'zmail_extra',
  'zmail_extra_hr',
]);
const QUOTE_IDS = new Set(['mail-editor-reference-message-container', 'OLK_SRC_BODY_SECTION']);
const REST_IDS = new Set(['divRplyFwdMsg', 'appendonsend', 'stopSpelling']);

// The verb, then perhaps the writer's name and address, then a colon or Zoho's closing dashes.
const WROTE =
  /(^|\s)(wrote|schrieb|a écrit|escribió|ha scritto|schreef|escreveu|skrev|kirjoitti|napisał|написал)[^\s:]*(\s.*)?(:|-{2,})\s*$/i;
const FORWARD =
  /^\s*(-{2,}\s*Forwarded message\s*-{2,}|Begin forwarded message:|-{2,}\s*Weitergeleitete Nachricht|-{2,}\s*Message transféré)/i;
const SEPARATOR = /^\s*(_{10,}|-{2,}\s*Original Message\s*-{2,})\s*$/i;
const OPENER = /^\s*(On|Am|Le|El|Il|Op|Em|Den|Dne|W dniu)\s/i;

/** Outlook's header of a quoted original: From, then Sent or Date, within the same block. */
function isHeaderBlock(text: string): boolean {
  return (
    /^(From|De|Von|Da|Van):\s/.test(text) &&
    /\b(Sent|Date|Envoyé|Gesendet|Inviato|Verzonden):\s/.test(text)
  );
}

/** The first line of the quote that ends `lines`, or null when the message ends in its own words. */
function trailingQuoteStart(lines: string[]): number | null {
  // Outlook's separator, or its header block, starts everything that follows.
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (isForward(line)) return null;
    if (SEPARATOR.test(line) && isHeaderBlock(nextLines(lines, i + 1, 4))) return i;
    if (isHeaderBlock(nextLines(lines, i, 4)) && lines.slice(i + 1).some(isMeaningful)) {
      if (i > 0 && (lines[i - 1] ?? '').trim() === '') return i;
    }
  }

  // Otherwise the quote is the run of `>` lines at the end, with the attribution above it.
  let end = lines.length;
  while (end > 0 && isBlank(lines[end - 1] ?? '')) end--;
  let start = end;
  while (start > 0 && !isMeaningful(lines[start - 1] ?? '')) start--;
  while (start < end && isBlank(lines[start] ?? '')) start++;
  if (start === end) return null;
  let above = start;
  while (above > 0 && isBlank(lines[above - 1] ?? '')) above--;
  if (above === 0 || !isAttribution(lines[above - 1] ?? '')) return start;
  // Clients wrap a long attribution, so it may begin up to two lines higher.
  for (let span = 3; span > 1; span--) {
    const first = lines[above - span] ?? '';
    if (
      above - span >= 0 &&
      OPENER.test(first) &&
      isAttribution(nextLines(lines, above - span, span))
    ) {
      return above - span;
    }
  }
  return above - 1;
}

function nextLines(lines: string[], from: number, count: number): string {
  return lines.slice(from, from + count).join(' ');
}

function trimTrailingBlankLines(lines: string[]): string[] {
  let end = lines.length;
  while (end > 0 && isBlank(lines[end - 1] ?? '')) end--;
  return lines.slice(0, end);
}

const isQuoted = (line: string) => /^\s*>/.test(line);
const isBlank = (line: string) => line.trim() === '';
const isMeaningful = (line: string) => !isBlank(line) && !isQuoted(line);

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
