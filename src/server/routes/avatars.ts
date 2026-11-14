import { byteHeaders, notFound } from './messages.ts';

/**
 * `/avatars/<key>` serves a verified sender's picture from the Avatar cache. A sender or their
 * site drew it, so it is served like a message's own bytes: Trail Mix shows it only as an image,
 * which runs and loads nothing, and opened directly it is an opaque document under a sandboxing
 * policy. A key names one picture's bytes, so a browser may keep it as long as it likes.
 */

/** A picture the Avatar cache holds: its type, as its first bytes showed, and its bytes. */
type Picture = { type: string; bytes: Uint8Array<ArrayBuffer> };

/** What the Mailroom serves of its Avatar cache. Null means it holds no picture under the key. */
export type AvatarBytes = { avatar: (key: string) => Promise<Picture | null> };

export async function serveAvatar(key: string, mailroom: AvatarBytes): Promise<Response> {
  const picture = await mailroom.avatar(key);
  if (picture === null) return notFound();
  return new Response(picture.bytes, {
    headers: byteHeaders({ type: picture.type, name: `${key}.${extensionOf(picture.type)}` }),
  });
}

function extensionOf(type: string): string {
  return (
    { 'image/svg+xml': 'svg', 'image/x-icon': 'ico', 'image/jpeg': 'jpg' }[type] ?? type.slice(6)
  );
}
