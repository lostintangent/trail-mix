import {
  addressesIn,
  refOf,
  type Account,
  type AccountId,
  type Address,
  type Body,
  type Message,
  type MessageRef,
} from '../../mail/core/index.ts';
import { replyRecipients, replySubject, withSignature } from './draft.ts';
import {
  cardOf,
  forwardedIn,
  forwardSubject,
  imagesShownBy,
  noteOf,
  type ForwardCard,
} from './forward.ts';

/**
 * What the composer holds while the member writes, and how it begins and is saved. A message starts
 * as a reply, a forward, a new message or a draft opened again. Each save replaces the draft before
 * it, and after one, every file the composer carries is named by the part of the saved draft that
 * holds it, so its bytes cross to the Mailroom once.
 */

/** A file the composer carries: bytes not yet saved, or a part of the draft saved last. */
export type Attached =
  | { file: File; contentId?: string }
  | { in: MessageRef; id: string; name: string; type: string; size: number; contentId?: string };

/** What the member is writing, everything a save needs. */
export type Writing = {
  account: AccountId;
  to: Address[];
  cc: Address[];
  bcc: Address[];
  subject: string;
  /** What the member writes, without the signature. */
  markdown: string;
  /** Saved under the `-- ` line that marks a signature, and kept apart from the editor. */
  signature?: string;
  /** The message this one replies to, which threads it. */
  inReplyTo?: MessageRef;
  /**
   * The Message-ID a draft answers, by its own In-Reply-To, when the index holds no message to
   * name. It makes the draft a reply. A save never carries it: the Mailroom keeps the draft's
   * threading from the draft itself.
   */
  answers?: string;
  /**
   * The message this one forwards, which the first save writes under the note and which threads
   * it. Every later save carries the forward on from the draft it replaces.
   */
  forwards?: MessageRef;
  /**
   * Who sent what this one forwards, when and what about, as its card shows. A save never carries
   * it.
   */
  forwarding?: ForwardCard;
  attachments: Attached[];
};

/** How long typing pauses before the draft is saved. */
export const SAVE_AFTER_MS = 1_500;

/** The longest typing goes on before the draft is saved anyway, which is the most a closed tab loses. */
export const SAVE_AT_LEAST_EVERY_MS = 5_000;

/** A new message from an account, signed with its signature. */
export function newMessage(account: Account): Writing {
  return { ...from(account), to: [], cc: [], bcc: [], subject: '', markdown: '', attachments: [] };
}

/** The message sent from another of the member's accounts, signed with that one's signature. */
export function sentFrom(writing: Writing, account: Account): Writing {
  return { ...writing, ...from(account) };
}

function from(account: Account): Pick<Writing, 'account' | 'signature'> {
  return { account: account.id, signature: account.signature?.trim() || undefined };
}

/**
 * A reply to a message, from the account it reached. It goes where the parent's Reply-To says, or
 * to its sender, and a reply to all also to everyone else it went to. Only the parent's body holds
 * its Reply-To, so a reply begun before the body arrives goes to the sender until it does.
 */
export function replyTo(parent: Message, body: Body | undefined, account: Account, all: boolean) {
  const { to, cc } = recipientsOf(parent, body, account, all);
  return {
    ...newMessage(account),
    to,
    cc,
    subject: replySubject(parent.subject),
    inReplyTo: refOf(parent),
  } satisfies Writing;
}

/**
 * A forward of a message, from the account it reached, to no one yet. The original's files travel
 * with it, each of which the member may take off, except the images its HTML shows, which go with
 * what it forwards.
 */
export function forwardingOf(original: Message, body: Body, account: Account): Writing {
  const shown = imagesShownBy(body.html?.trim() ? body.html : '');
  return {
    ...newMessage(account),
    subject: forwardSubject(original.subject),
    forwards: refOf(original),
    forwarding: { from: original.from, subject: original.subject, date: original.date },
    attachments: body.attachments
      .filter(({ contentId }) => contentId === undefined || !shown.has(contentId))
      .map(({ id, name, type, size }) => ({ in: refOf(original), id, name, type, size })),
  };
}

/** Whom a reply goes to: the parent's Reply-To when its body says, or else its sender. */
export function recipientsOf(
  parent: Message,
  body: Body | undefined,
  account: Account,
  all: boolean,
): Pick<Writing, 'to' | 'cc'> {
  const replyTo = header(body, 'Reply-To');
  return replyRecipients(
    { ...parent, ...(replyTo ? { replyTo: addressesIn(replyTo) } : {}) },
    [account.address],
    all,
  );
}

/**
 * A draft opened again: its words exactly as written, which its text part holds, its files as the
 * parts that hold them, and the message it replies to when the conversation still has it, or else
 * the Message-ID it answers. A forward opens as its note, with its card, and names the message it
 * forwards when the conversation has it.
 */
export function reopened(draft: Message, body: Body, conversation: readonly Message[]): Writing {
  const parentId = header(body, 'In-Reply-To')?.trim();
  const parent = parentId
    ? conversation.find((message) => message.messageId === parentId && !message.flags.draft)
    : undefined;
  const bcc = header(body, 'Bcc');
  const forwarded = forwardedIn(body);
  // What a forward carries may hold a signature of its own, so it comes off first.
  const { markdown, signature } = signed(forwarded ? noteOf(body.text ?? '') : (body.text ?? ''));
  const carried = new Set(forwarded?.images.map(({ contentId }) => contentId));
  const threading = forwarded
    ? { forwarding: cardOf(forwarded), ...(parent ? { forwards: refOf(parent) } : {}) }
    : parent
      ? { inReplyTo: refOf(parent) }
      : parentId
        ? { answers: parentId }
        : {};
  return {
    account: draft.account,
    to: draft.to,
    cc: draft.cc,
    bcc: bcc ? addressesIn(bcc) : [],
    subject: draft.subject,
    markdown,
    ...(signature ? { signature } : {}),
    ...threading,
    attachments: body.attachments
      .filter(({ contentId }) => !carried.has(contentId))
      .map((part) => ({ ...part, in: refOf(draft) })),
  };
}

/**
 * What a save sends of the writing: the Markdown signed, and every file it carries, except an
 * image the member has taken out of the text, which leaves the draft with it.
 */
export function draftInputOf({
  attachments,
  signature,
  answers: _answers,
  forwarding: _forwarding,
  ...writing
}: Writing) {
  const shown = (contentId: string | undefined) =>
    contentId === undefined || writing.markdown.includes(`cid:${contentId}`);
  return {
    ...writing,
    markdown: withSignature(writing.markdown, signature),
    attachments: attachments
      .filter(({ contentId }) => shown(contentId))
      .map((attached) => ('file' in attached ? attached : { in: attached.in, id: attached.id })),
  };
}

/** Text split at its last `-- ` line into what was written and the signature under it. */
function signed(text: string): { markdown: string; signature?: string } {
  const at = text.lastIndexOf('\n-- \n');
  if (at >= 0)
    return { markdown: text.slice(0, at).replace(/\n$/, ''), signature: text.slice(at + 5) };
  if (text.startsWith('-- \n')) return { markdown: '', signature: text.slice(4) };
  return { markdown: text };
}

/**
 * The files the composer carries once a save has made `saved` the draft, each named by the part of
 * it that holds it. A pasted image is found by its Content-ID, and any other file by its name and
 * size, in the order the composer holds them. A file the saved draft doesn't hold stays as it was.
 */
export function afterSave(
  attachments: readonly Attached[],
  saved: MessageRef,
  body: Body,
): Attached[] {
  const parts = [...body.attachments];
  return attachments.map((attached) => {
    const { name, size } = 'file' in attached ? attached.file : attached;
    const at = parts.findIndex((part) =>
      attached.contentId !== undefined
        ? part.contentId === attached.contentId
        : part.contentId === undefined && part.name === name && part.size === size,
    );
    const part = parts[at];
    if (!part) return attached;
    parts.splice(at, 1);
    return { ...part, in: saved };
  });
}

/** Addresses as the member reads and writes them in a field: `Name <address>`, comma-separated. */
export function addressText(addresses: readonly Address[]): string {
  return addresses
    .map(({ name, email }) => {
      if (!name) return email;
      const quoted = /[",;<>()@[\]\\:]/.test(name) ? `"${name.replace(/(["\\])/g, '\\$1')}"` : name;
      return `${quoted} <${email}>`;
    })
    .join(', ');
}

function header(body: Body | undefined, name: string): string | undefined {
  const wanted = name.toLowerCase();
  return body?.headers.find(([key]) => key.toLowerCase() === wanted)?.[1];
}
