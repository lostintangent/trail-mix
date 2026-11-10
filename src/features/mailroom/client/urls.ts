import type { MessageRef } from '../../mail/core/index.ts';

/**
 * The plain GET routes that carry bytes: a message's source, one of its parts, and a remote image
 * through the proxy. These helpers are the only place their URLs are built, and the routes read
 * them back with `readMessagePath`, so the two can't disagree.
 *
 * A message is `/messages/<account>/<path>/<uidValidity>/<uid>`, and a part adds `/<attachment>`.
 * Each segment is encoded on its own, so a folder like "Projects/Toy Box" stays one segment.
 */

export const messageUrl = (ref: MessageRef) =>
  `/messages/${[ref.account, ref.path, ref.uidValidity, ref.uid].map(segment).join('/')}`;

export const partUrl = (ref: MessageRef, attachmentId: string) =>
  `${messageUrl(ref)}/${segment(attachmentId)}`;

export const imageUrl = (url: string) => `/images?${new URLSearchParams({ url })}`;

/** The message, and the part if there is one, that a path names, or nothing if it names none. */
export function readMessagePath(
  pathname: string,
): { ref: MessageRef; attachmentId?: string } | null {
  const [root, ...segments] = pathname.split('/').slice(1);
  if (root !== 'messages' || segments.length < 4 || segments.length > 5) return null;
  const [account, path, uidValidity, uid, attachmentId] = segments.map(decode);
  if (account === undefined || path === undefined) return null;
  const numbers = [uidValidity, uid].map(uint32);
  if (numbers[0] === undefined || numbers[1] === undefined) return null;
  const ref = { account, path, uidValidity: numbers[0], uid: numbers[1] };
  if (segments.length === 4) return { ref };
  return attachmentId ? { ref, attachmentId } : null;
}

/** encodeURIComponent leaves `!'()*` alone, and a Content-Security-Policy source can't hold them. */
const segment = (value: string | number) =>
  encodeURIComponent(value).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );

const decode = (value: string) => {
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
};

/** UIDVALIDITY and UID are positive 32-bit numbers, written in plain digits. */
const uint32 = (value: string | undefined) => {
  if (!value || !/^[1-9]\d*$/.test(value)) return undefined;
  const number = Number(value);
  return number <= 0xffff_ffff ? number : undefined;
};
