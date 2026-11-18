import {
  referencesOf,
  type Address,
  type Envelope,
  type MimeAttachment,
  type MimeMessage,
} from '../../mail/core/index.ts';
import { FORWARDED_HEADER, withForward, type Forwarded } from './forward.ts';
import { contentIdsIn, renderMarkdown } from './markdown.ts';

/**
 * What a member writes, made into mail. The composer saves Markdown, and the message it becomes has
 * that Markdown rendered as its HTML part and, exactly as written, as its plain-text part. A reply
 * carries the headers that thread it in any client, and so does a forward, which carries what it
 * forwards under the Markdown. A pasted image travels inline, related to the HTML that shows it,
 * and every other file is attached.
 */

/**
 * What a member composed, resolved for writing as mail: From, the recipients, the subject, the
 * Markdown, the ids of the message it answers and every file's bytes. The Mailroom makes one from
 * each save of a draft.
 */
export type Composed = {
  from: Address;
  to: Address[];
  cc: Address[];
  bcc: Address[];
  subject: string;
  markdown: string;
  /** The message this one replies to, or forwards. */
  parent?: Pick<Envelope, 'messageId' | 'references'>;
  /** What this one forwards, under the Markdown. */
  forwarded?: Forwarded;
  /** A file with a Content-ID is an image the Markdown shows by `cid:`, if it still does. */
  attachments: MimeAttachment[];
};

/**
 * What a member composed, as a message to write, given what makes this copy of it: its date,
 * Message-ID and boundary. It throws when the Markdown shows an image that does not travel with
 * it, so no message goes out with a broken image. A file whose Content-ID the Markdown never shows
 * is attached like any other, so nothing the member added is lost.
 */
export function messageOf(
  composed: Composed,
  copy: Pick<MimeMessage, 'date' | 'messageId' | 'boundary'>,
): MimeMessage {
  const { forwarded } = composed;
  // The forward's images are its own, so a file of the member's under one of their Content-IDs,
  // as a forward opened again would carry, goes with the forward.
  const forwards = new Set(forwarded?.images.map(({ contentId }) => contentId));
  const own = composed.attachments.filter(({ contentId }) => !forwards.has(contentId ?? ''));
  const images = new Map<string, MimeAttachment>();
  for (const file of own) {
    if (file.contentId === undefined) continue;
    if (images.has(file.contentId)) {
      throw new Error(`Two attachments have the Content-ID ${file.contentId}.`);
    }
    images.set(file.contentId, file);
  }
  const shown = new Set(contentIdsIn(composed.markdown));
  for (const id of shown) {
    const file = images.get(id);
    if (file && !file.type.startsWith('image/')) {
      throw new Error(`The Markdown shows ${file.name} as an image, but it is ${file.type}.`);
    }
  }
  const written = composed.markdown.trim() !== '';
  const references = composed.parent
    ? referencesOf(composed.parent.references.join(' '), composed.parent.messageId)
    : [];
  const note = {
    text: composed.markdown,
    html: written ? renderMarkdown(composed.markdown, new Set(images.keys())) : '',
  };
  const { text, html } = forwarded ? withForward(note, forwarded) : note;
  return {
    ...copy,
    from: composed.from,
    to: composed.to,
    cc: composed.cc,
    bcc: composed.bcc,
    subject: composed.subject,
    ...(references.length ? { references } : {}),
    ...(forwarded?.messageId ? { headers: [[FORWARDED_HEADER, forwarded.messageId]] } : {}),
    text,
    ...(html ? { html } : {}),
    attachments: [
      ...own.map(({ contentId, ...file }) =>
        contentId !== undefined && shown.has(contentId) ? { ...file, contentId } : file,
      ),
      ...(forwarded?.images ?? []),
    ],
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
