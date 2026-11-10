import {
  messageIdOf,
  referencesOf,
  type Address,
  type Envelope,
  type Flags,
  type MessageRef,
} from '../../../mail/core/index.ts';

/**
 * Envelopes from what an IMAP server reports. Fetching is the provider's work, and this turns the
 * answer into the vocabulary: addresses, the headers that link conversations and lists, whether a
 * message has attachments, and a preview. The shapes below are the parts of IMAP's answer used.
 */

/** A node of BODYSTRUCTURE. */
export type Structure = {
  part?: string;
  type: string;
  parameters?: Record<string, string>;
  encoding?: string;
  disposition?: string;
  id?: string;
  childNodes?: Structure[];
};

export type ImapAddress = { name?: string; address?: string };

export type ImapEnvelope = {
  date?: Date | string;
  subject?: string;
  messageId?: string;
  inReplyTo?: string;
  from?: ImapAddress[];
  to?: ImapAddress[];
  cc?: ImapAddress[];
};

export type ImapMessage = {
  ref: MessageRef;
  flags: Flags;
  envelope: ImapEnvelope;
  /** The raw References, List-Id and List-Unsubscribe header lines, as fetched. */
  headers: string;
  structure?: Structure;
  /** When IMAP's envelope has no date. */
  internalDate?: Date | string;
  /** The decoded start of the part `previewPartOf` chose, or empty when there is none. */
  previewText: string;
};

const PREVIEW_LENGTH = 200;

export function envelopeOf(message: ImapMessage): Envelope {
  const { ref, flags, envelope, structure } = message;
  const headers = headerValues(message.headers);
  const listId = idIn(headers.get('list-id'));
  const unsubscribe = headers.get('list-unsubscribe');
  const date = envelope.date ?? message.internalDate;
  return {
    ...ref,
    messageId: messageIdOf(envelope.messageId),
    references: referencesOf(headers.get('references'), envelope.inReplyTo),
    from: addressesOf(envelope.from)[0] ?? { email: '' },
    to: addressesOf(envelope.to),
    cc: addressesOf(envelope.cc),
    subject: envelope.subject ?? '',
    date: date ? new Date(date).toISOString() : new Date(0).toISOString(),
    preview: previewOf(message.previewText, previewPartOf(structure)?.html ?? false),
    flags,
    hasAttachments: structure ? hasAttachments(structure) : false,
    ...(listId ? { list: { id: listId, ...(unsubscribe ? { unsubscribe } : {}) } } : {}),
  };
}

/**
 * The part a preview is read from: the first plain text part, or failing that the first HTML
 * part, never one that is an attachment.
 */
export function previewPartOf(
  structure: Structure | undefined,
): { part: string; html: boolean; charset?: string; encoding?: string } | undefined {
  const leaves = structure
    ? leavesOf(structure).filter((leaf) => leaf.disposition !== 'attachment')
    : [];
  const plain = leaves.find((leaf) => leaf.type === 'text/plain');
  const chosen = plain ?? leaves.find((leaf) => leaf.type === 'text/html');
  if (!chosen) return undefined;
  return {
    // A message that is a single part has no part number. Its text is the part called TEXT.
    part: chosen.part ?? 'TEXT',
    html: chosen.type === 'text/html',
    ...(chosen.parameters?.charset ? { charset: chosen.parameters.charset } : {}),
    ...(chosen.encoding ? { encoding: chosen.encoding } : {}),
  };
}

/**
 * Whether a person would see an attachment: a part marked as one, or any part that is neither
 * text nor an image the HTML shows inline by Content-ID.
 */
export function hasAttachments(structure: Structure): boolean {
  return leavesOf(structure).some(
    (leaf) =>
      leaf.disposition === 'attachment' ||
      (!leaf.type.startsWith('text/') &&
        !(leaf.type.startsWith('image/') && leaf.id && leaf.disposition !== 'attachment')),
  );
}

/** The first 200 characters a person would read: quoted lines and markup left out. */
export function previewOf(text: string, html: boolean): string {
  const readable = html ? textOfHtml(text) : text;
  const unquoted = readable
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith('>'))
    .join(' ');
  return unquoted.replace(/\s+/g, ' ').trim().slice(0, PREVIEW_LENGTH);
}

function leavesOf(node: Structure): Structure[] {
  // A message attached whole is one attachment, whatever is inside it.
  if (node.type === 'message/rfc822') return [node];
  if (node.childNodes?.length) return node.childNodes.flatMap(leavesOf);
  return node.type.startsWith('multipart/') ? [] : [node];
}

function addressesOf(list: ImapAddress[] | undefined): Address[] {
  return (list ?? [])
    .filter((entry) => entry.address)
    .map((entry) =>
      entry.name
        ? { name: entry.name, email: entry.address ?? '' }
        : { email: entry.address ?? '' },
    );
}

/** Header lines by lowercase name, with folding undone. */
function headerValues(block: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const line of block.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/)) {
    const colon = line.indexOf(':');
    if (colon > 0)
      values.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
  }
  return values;
}

function idIn(header: string | undefined) {
  return /<([^>]+)>/.exec(header ?? '')?.[1] ?? header?.trim() ?? '';
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

/** Text a person would read in HTML, closely enough for a preview. Nothing here is rendered. */
function textOfHtml(html: string): string {
  return html
    .replace(/<(head|style|script|title)\b[\s\S]*?(<\/\1\s*>|$)/gi, ' ')
    .replace(/<blockquote\b[\s\S]*?(<\/blockquote\s*>|$)/gi, ' ')
    .replace(/<(br|p|div|tr|li|h\d)\b[^>]*>/gi, '\n')
    .replace(/<[^>]*>?/g, ' ')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity: string, name: string) => {
      if (name.startsWith('#')) {
        const code =
          name[1]?.toLowerCase() === 'x'
            ? parseInt(name.slice(2), 16)
            : parseInt(name.slice(1), 10);
        return Number.isFinite(code) && code > 0 && code < 0x110000
          ? String.fromCodePoint(code)
          : ' ';
      }
      return ENTITIES[name.toLowerCase()] ?? entity;
    });
}
