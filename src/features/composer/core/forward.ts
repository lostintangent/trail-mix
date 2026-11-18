import {
  decodedEntities,
  type Address,
  type Body,
  type Envelope,
  type MimeAttachment,
} from '../../mail/core/index.ts';
import { FORWARD_CLASS, FORWARD_MARKER, FORWARDED_HEADER } from './forwardMarks.ts';
import { escapeHtml, WRITTEN_STYLE } from './markdown.ts';
import { nestedHtml } from './nesting.ts';

/**
 * A forward: a message sent on to someone new, with the member's note over it. Under the note go
 * the header block every mail client writes, naming who sent the original, when, what about and to
 * whom, and then the original itself, its HTML and its text as they were sent, with the images its
 * HTML shows. Its other files travel as the forward's attachments, which the member may take off.
 *
 * The forward is part of the draft, so a save carries it on from the draft it replaces and never
 * needs the original again. Trail Mix finds it in a draft it wrote by the marker line in the text,
 * whose first exact copy is always its own, and the element that holds it in the HTML, which the
 * note's HTML can't hold, since the Markdown renders any HTML written in it as text.
 */

/** A message as the Mailroom reads it from its bytes, to forward it or to carry a forward on. */
export type ReadMessage = Pick<
  Envelope,
  'from' | 'to' | 'cc' | 'subject' | 'messageId' | 'references'
> &
  Pick<Body, 'html' | 'text' | 'headers'> & { attachments: MimeAttachment[] };

/**
 * What goes under a forward's note: the header block over the original, as HTML and as text, the
 * style sheet the original's HTML needs, scoped to it, the images it shows, and its Message-ID.
 */
export type Forwarded<Image = MimeAttachment> = {
  messageId: string;
  html: string;
  /** The original's style sheets, which the forward's head holds, since some clients read no other. */
  css: string;
  text: string;
  images: Image[];
};

/** Who sent the original, when and what about, as a forward's card shows it. */
export type ForwardCard = Pick<Envelope, 'from' | 'subject'> & {
  /** ISO 8601, when the original's Date header could be read. */
  date?: string;
};

/** The class of the element that holds the original, to which its style sheets are scoped. */
const ORIGINAL_CLASS = 'trailmix-forwarded';

const OPEN = `<div class="${FORWARD_CLASS}">`;
const HEAD = '<html><head><style>';
const HEAD_END = '</style></head><body>';
const DOCUMENT_END = '</body></html>';

/** What a message forwards: the header block naming it, and the message as it was sent. */
export function forwardOf(original: ReadMessage): Forwarded {
  const lines = headerLines(original);
  const plain = original.text?.trim() ? lined(original.text) : textOfHtml(original.html ?? '');
  const nested = original.html?.trim() ? nestedHtml(original.html, ORIGINAL_CLASS) : undefined;
  const shown = nested ? imagesShownBy(original.html!) : new Set<string>();
  const header = lines
    .map(
      ([label, value]) =>
        `${label}: ${label === 'From' ? sender(original.from) : escapeHtml(value)}`,
    )
    .join('<br>');
  const content =
    nested?.html ??
    `<div class="${ORIGINAL_CLASS}"><div style="white-space: pre-wrap">${escapeHtml(plain).replace(/\n/g, '<br>')}</div></div>`;
  return {
    messageId: original.messageId,
    html: `${OPEN}<div style="${WRITTEN_STYLE}">${escapeHtml(FORWARD_MARKER)}<br>${header}</div><br>${content}</div>`,
    css: nested?.css ?? '',
    text: [FORWARD_MARKER, ...lines.map(([label, value]) => `${label}: ${value}`), '', plain]
      .join('\n')
      .trimEnd(),
    images: onePerId(
      original.attachments.filter(
        ({ contentId }) => contentId !== undefined && shown.has(contentId),
      ),
    ),
  };
}

/**
 * What a draft Trail Mix wrote forwards, under its note, or nothing for any other message. Its
 * images are the files whose Content-IDs the forwarded HTML shows.
 */
export function forwardedIn<Image extends { contentId?: string }>(draft: {
  headers: readonly [string, string][];
  html?: string;
  text?: string;
  attachments: readonly Image[];
}): Forwarded<Image> | undefined {
  const text = lined(draft.text ?? '');
  const marker = markerAt(text);
  const html = draft.html ?? '';
  const headEnd = html.startsWith(HEAD) ? html.indexOf(HEAD_END) : -1;
  const css = headEnd < 0 ? undefined : html.slice(HEAD.length, headEnd);
  const from = css === undefined ? 0 : HEAD.length + css.length + HEAD_END.length;
  const at = html.indexOf(OPEN, from);
  // The note's HTML is all that comes before the forward's, and it is the Markdown's, or nothing.
  if (
    marker < 0 ||
    at < 0 ||
    (at > from && !html.startsWith(`<div style="${WRITTEN_STYLE}">`, from))
  )
    return undefined;
  const end = css !== undefined && html.endsWith(DOCUMENT_END) ? -DOCUMENT_END.length : undefined;
  const forwarded = html.slice(at, end);
  const shown = imagesShownBy(`${css ?? ''}${forwarded}`);
  return {
    messageId: headerIn(draft.headers, FORWARDED_HEADER)?.trim() ?? '',
    html: forwarded,
    css: css ?? '',
    text: text.slice(marker).trimEnd(),
    images: onePerId(
      draft.attachments.filter(({ contentId }) => contentId !== undefined && shown.has(contentId)),
    ),
  };
}

/** A forward's text and HTML: the note's over the forward's, in the one document both are in. */
export function withForward(
  note: { text: string; html: string },
  forwarded: Forwarded<unknown>,
): { text: string; html: string } {
  const text = note.text.replace(ESCAPED_MARKER, (line) => `\\${line}`);
  const body = `${note.html}${forwarded.html}`;
  return {
    text: text === '' ? forwarded.text : `${text}\n\n${forwarded.text}`,
    html: forwarded.css ? `${HEAD}${forwarded.css}${HEAD_END}${body}${DOCUMENT_END}` : body,
  };
}

/**
 * The note a forward's text holds over what it forwards, as the member wrote it, or the whole text
 * when it forwards nothing.
 */
export function noteOf(text: string): string {
  const lines = lined(text);
  const marker = markerAt(lines);
  if (marker < 0) return text;
  return lines.slice(0, Math.max(0, marker - 2)).replace(ESCAPED_ONCE, (line) => line.slice(1));
}

/** Who sent a forward's original, when and what about, as its header block says. */
export function cardOf(forwarded: Pick<Forwarded<unknown>, 'text'>): ForwardCard {
  const said = new Map<string, string>();
  for (const line of forwarded.text.split('\n').slice(1)) {
    if (line === '') break;
    const colon = line.indexOf(': ');
    if (colon > 0 && !said.has(line.slice(0, colon)))
      said.set(line.slice(0, colon), line.slice(colon + 2));
  }
  // A Date header may hold comments, such as the zone's name, which not every engine parses.
  const date = said
    .get('Date')
    ?.replace(/\([^()]*\)/g, '')
    .trim();
  const parsed = date ? Date.parse(date) : NaN;
  return {
    from: addressOf(said.get('From') ?? ''),
    subject: said.get('Subject') ?? '',
    ...(Number.isNaN(parsed) ? {} : { date: new Date(parsed).toISOString() }),
  };
}

/** A forward's subject: the original's, with `Fwd: ` in front unless it already says it forwards. */
export function forwardSubject(subject: string): string {
  return /^\s*(?:fwd?|fw)\s*:/i.test(subject) ? subject : `Fwd: ${subject}`.trimEnd();
}

/** The Content-IDs of the images HTML shows by `cid:`, each without its angle brackets. */
export function imagesShownBy(html: string): Set<string> {
  const ids = new Set<string>();
  for (const [, raw] of html.matchAll(/(?:^|["'(=;\s])cid:([^\s"'()<>&]+)/gi)) {
    let id = decodedEntities(raw!);
    try {
      id = decodeURIComponent(id);
    } catch {
      // Kept as written.
    }
    ids.add(id.replace(/^<|>$/g, ''));
  }
  return ids;
}

/** A note's line that reads as the marker, or as one escaped, which a forward's note escapes once. */
const ESCAPED_MARKER = new RegExp(`^\\\\*${FORWARD_MARKER}$`, 'gm');

/** A note's line escaped that way, at least once. */
const ESCAPED_ONCE = new RegExp(`^\\\\+${FORWARD_MARKER}$`, 'gm');

/** The header block's lines, each label with its value. */
function headerLines(original: ReadMessage): [label: string, value: string][] {
  const date = headerIn(original.headers, 'Date');
  const lines: [string, string | undefined][] = [
    ['From', named(original.from)],
    ['Date', date],
    ['Subject', original.subject],
    ['To', original.to.map(named).join(', ')],
    ['Cc', original.cc.map(named).join(', ')],
  ];
  // Each on one line, since a line of its own ends the block.
  return lines
    .map(([label, value]): [string, string] => [label, value?.replace(/\s+/g, ' ').trim() ?? ''])
    .filter(([label, value]) => value !== '' || label === 'From' || label === 'Subject');
}

function named({ name, email }: Address): string {
  return name ? `${name} <${email}>` : email;
}

function sender({ name, email }: Address): string {
  return name
    ? `<strong>${escapeHtml(name)}</strong> &lt;${escapeHtml(email)}&gt;`
    : escapeHtml(email);
}

function addressOf(text: string): Address {
  const angled = /^(.*?)\s*<([^<>]*)>$/.exec(text);
  return angled ? { name: angled[1]!, email: angled[2]! } : { name: '', email: text };
}

/** Where the marker line starts in text, or -1. */
function markerAt(text: string): number {
  if (text.startsWith(`${FORWARD_MARKER}\n`) || text === FORWARD_MARKER) return 0;
  const at = text.search(new RegExp(`\\n${FORWARD_MARKER}(?:\\n|$)`));
  return at < 0 ? -1 : at + 1;
}

/** Text with each line ended by `\n` alone. */
function lined(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

function headerIn(headers: readonly [string, string][], name: string): string | undefined {
  const wanted = name.toLowerCase();
  return headers.find(([key]) => key.toLowerCase() === wanted)?.[1];
}

/** Each image once, as a message carries one part for each Content-ID. */
function onePerId<Image extends { contentId?: string }>(images: Image[]): Image[] {
  const seen = new Set<string | undefined>();
  return images.filter(({ contentId }) => !seen.has(contentId) && !!seen.add(contentId));
}

/** Text a person reads in HTML, a line for each of its lines, for a forward that has no text. */
function textOfHtml(html: string): string {
  return decodedEntities(
    html
      .replace(/<!--[\s\S]*?(?:-->|$)/g, '')
      .replace(/<(head|style|script|title)\b[\s\S]*?(?:<\/\1\s*>|$)/gi, '')
      .replace(/<br\b[^>]*>/gi, '\n')
      .replace(/<\/?(?:p|div|tr|li|h\d|table|blockquote|pre|ul|ol|hr)\b[^>]*>/gi, '\n')
      .replace(/<[^>]*>?/g, ''),
  )
    .split('\n')
    .map((line) => line.replace(/[\t ]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
