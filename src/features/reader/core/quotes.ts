/**
 * Where a message stops being its writer's own words and starts quoting the conversation it
 * replies to. Only a quote that runs to the end of the message folds: replies written between
 * quoted lines stay as they are, and so does a message that is nothing but a quote or a forward.
 *
 * Plain text is folded here whole. HTML is folded by the sanitizer's hooks, which ask
 * `quoteMarker` and `isAttribution` about each element they visit.
 */

/** Plain text split at its trailing quote. `quote` is empty when nothing folds. */
export type FoldedText = { text: string; quote: string };

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

export type ElementTraits = { tag: string; id: string; className: string; type: string };

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
export function isForward(text: string): boolean {
  return FORWARD.test(text.slice(0, 400));
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
