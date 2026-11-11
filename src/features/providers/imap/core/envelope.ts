import {
  messageIdOf,
  referencesOf,
  type Address,
  type Envelope,
  type Flags,
  type MessageRef,
} from '../../../mail/core/index.ts';
import { isVerified } from './authentication.ts';
import { previewOf } from './preview.ts';

/**
 * Envelopes from what an IMAP server reports. Fetching is the provider's work, and this turns the
 * answer into the vocabulary: addresses, the headers that link conversations and lists, whether a
 * message has attachments, a preview, and whether the account's own server vouched for its sender.
 * The shapes below are the parts of IMAP's answer used.
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
  /** The raw References, List-Id, List-Unsubscribe and Authentication-Results lines, in order. */
  headers: string;
  structure?: Structure;
  /** When IMAP's envelope has no date. */
  internalDate?: Date | string;
  /** The decoded start of the part `previewPartOf` chose, or empty when there is none. */
  previewText: string;
};

/**
 * A message's envelope. `authServers` are the names the account's server signs its
 * Authentication-Results with, as its preset gives them.
 */
export function envelopeOf(message: ImapMessage, authServers: readonly string[] = []): Envelope {
  const { ref, flags, envelope, structure } = message;
  const headers = headerValues(message.headers);
  const listId = idIn(headers.get('list-id'));
  const unsubscribe = headers.get('list-unsubscribe');
  const date = envelope.date ?? message.internalDate;
  const from = addressesOf(envelope.from)[0] ?? { email: '' };
  return {
    ...ref,
    messageId: messageIdOf(envelope.messageId),
    references: referencesOf(headers.get('references'), envelope.inReplyTo),
    from,
    to: addressesOf(envelope.to),
    cc: addressesOf(envelope.cc),
    subject: envelope.subject ?? '',
    date: date ? new Date(date).toISOString() : new Date(0).toISOString(),
    preview: previewOf(message.previewText, previewPartOf(structure)?.html ?? false),
    flags,
    hasAttachments: structure ? hasAttachments(structure) : false,
    ...(listId ? { list: { id: listId, ...(unsubscribe ? { unsubscribe } : {}) } } : {}),
    verified: isVerified(message.headers, authServers, from.email),
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
