import {
  referencesOf,
  type Address,
  type Envelope,
  type MimeAttachment,
  type MimeMessage,
} from '../../mail/core/index.ts';
import { contentIdsIn, renderMarkdown } from './markdown.ts';

/**
 * What a member writes, made into mail. The composer saves Markdown, and the message it becomes has
 * that Markdown rendered as its HTML part and, exactly as written, as its plain-text part. A reply
 * carries the headers that thread it in any client. A pasted image travels inline, related to the
 * HTML that shows it, and every other file is attached.
 */

/** A draft as the Mailroom writes it: what the composer saved, with its files' bytes. */
export type Draft = {
  from: Address;
  to: Address[];
  cc: Address[];
  bcc: Address[];
  subject: string;
  markdown: string;
  /** The message this one replies to. */
  parent?: Pick<Envelope, 'messageId' | 'references'>;
  /** A file with a Content-ID is an image the Markdown shows by `cid:`, if it still does. */
  attachments: MimeAttachment[];
};

/**
 * The draft as a message to write, given what makes this copy of it: its date, Message-ID and
 * boundary. It throws when the Markdown shows an image that does not travel with it, so no message
 * goes out with a broken image. A file whose Content-ID the Markdown never shows is attached like
 * any other, so nothing the member added is lost.
 */
export function messageOf(
  draft: Draft,
  copy: Pick<MimeMessage, 'date' | 'messageId' | 'boundary'>,
): MimeMessage {
  const images = new Map<string, MimeAttachment>();
  for (const file of draft.attachments) {
    if (file.contentId === undefined) continue;
    if (images.has(file.contentId)) {
      throw new Error(`Two attachments have the Content-ID ${file.contentId}.`);
    }
    images.set(file.contentId, file);
  }
  const shown = new Set(contentIdsIn(draft.markdown));
  for (const id of shown) {
    const file = images.get(id);
    if (file && !file.type.startsWith('image/')) {
      throw new Error(`The Markdown shows ${file.name} as an image, but it is ${file.type}.`);
    }
  }
  const written = draft.markdown.trim() !== '';
  const references = draft.parent
    ? referencesOf(draft.parent.references.join(' '), draft.parent.messageId)
    : [];
  return {
    ...copy,
    from: draft.from,
    to: draft.to,
    cc: draft.cc,
    bcc: draft.bcc,
    subject: draft.subject,
    ...(references.length ? { references } : {}),
    text: draft.markdown,
    ...(written ? { html: renderMarkdown(draft.markdown, new Set(images.keys())) } : {}),
    attachments: draft.attachments.map(({ contentId, ...file }) =>
      contentId !== undefined && shown.has(contentId) ? { ...file, contentId } : file,
    ),
  };
}

/**
 * The Content-ID for an image pasted into the composer, from something unique to it, such as a
 * random UUID. Its domain is reserved, so it names no one's server, the member's included.
 */
export function contentIdFor(unique: string): string {
  return `${unique}@trailmix.invalid`;
}

/** A reply's subject: the parent's, with `Re: ` in front unless it already starts with a reply prefix. */
export function replySubject(subject: string): string {
  return /^\s*re\s*(?:\[\d+\])?\s*:/i.test(subject) ? subject : `Re: ${subject}`.trimEnd();
}

/**
 * Who a reply goes to. A reply goes to the parent's Reply-To, which mailing lists and help desks
 * set, or else to its sender. A reply to all also goes to everyone else the parent was sent to,
 * its Cc staying Cc. The member's own addresses are left out, and a Reply-To that names only them
 * is passed over for the sender. A reply to the member's own message goes where that message went.
 * Each address appears once, in the first place it would.
 */
export function replyRecipients(
  parent: Pick<Envelope, 'from' | 'to' | 'cc'> & { replyTo?: Address[] },
  own: readonly string[],
  all: boolean,
): { to: Address[]; cc: Address[] } {
  const mine = new Set(own.map((email) => email.toLowerCase()));
  const isMine = ({ email }: Address) => mine.has(email.toLowerCase());
  const fromMe = isMine(parent.from);
  const answer = (parent.replyTo ?? []).filter((address) => !isMine(address));
  const to = fromMe
    ? parent.to
    : [...(answer.length ? answer : [parent.from]), ...(all ? parent.to : [])];
  const cc = all ? parent.cc : [];
  const seen = new Set(fromMe ? [] : mine);
  const once = (addresses: readonly Address[]) =>
    addresses.filter(({ email }) => {
      const key = email.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  return { to: once(to), cc: once(cc) };
}

/**
 * Markdown with the account's signature under it, after the `-- ` line that tells mail clients
 * where a signature starts. The composer starts a message this way, so the signature is part of
 * what the member writes and can change.
 */
export function withSignature(markdown: string, signature: string | undefined): string {
  const signed = signature?.trim();
  return signed ? `${markdown}\n\n-- \n${signed}` : markdown;
}
