import type { Body, Message, MessageRef } from '../../mail/core/index.ts';
import { imageUrl, partUrl } from '../../mailroom/client/index.ts';
import { sanitizeMail, type SafeMail } from '../core/sanitize.ts';

/**
 * A message's HTML, sanitized once for each choice about its images and kept. A body never
 * changes for its message, so a message opened again, or prepared ahead while the browser was
 * idle, shows at once.
 */
export function safeMail(
  message: MessageRef,
  body: Body,
  imagesAllowed: boolean,
): SafeMail | undefined {
  if (body.html === undefined) return undefined;
  const key = `${refKey(message)}\u0000${imagesAllowed}`;
  const kept = sanitized.get(key);
  if (kept) return kept;
  const parts = new Map(
    body.attachments.flatMap(({ id, contentId }) =>
      contentId ? [[contentId, absolute(partUrl(refOf(message), id))] as const] : [],
    ),
  );
  const mail = sanitizeMail(body.html, {
    part: (contentId) => parts.get(contentId),
    remote: imagesAllowed ? (url) => absolute(imageUrl(url)) : undefined,
  });
  sanitized.set(key, mail);
  if (sanitized.size > KEPT) sanitized.delete(sanitized.keys().next().value ?? '');
  return mail;
}

/** Whether the member allowed this sender's remote images on the message's account. */
export function imagesAllowed(message: Message, allowImagesFrom: string[]): boolean {
  const sender = message.from.email.toLowerCase();
  return allowImagesFrom.some((email) => email.toLowerCase() === sender);
}

/** Just a message's identity, as queries and URLs name it. */
export const refOf = ({ account, path, uidValidity, uid }: MessageRef): MessageRef => ({
  account,
  path,
  uidValidity,
  uid,
});

export const refKey = ({ account, path, uidValidity, uid }: MessageRef) =>
  [account, path, uidValidity, uid].join('\u0000');

/** How many sanitized messages are kept, oldest dropped first. */
const KEPT = 64;
const sanitized = new Map<string, SafeMail>();

/** The frame's policy names exact URLs, so the ones it loads are absolute. */
const absolute = (url: string) => new URL(url, location.origin).href;
