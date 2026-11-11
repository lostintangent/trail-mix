import type { MessageRef } from '../../features/mail/core/index.ts';

/**
 * `/messages/<ref>` serves a message's raw source and `/messages/<ref>/<attachment>` one of its
 * parts, both from the Mailroom's body cache.
 *
 * Every byte here was written by the sender, and this route shares Trail Mix's origin and the
 * member's sign-in. So nothing it serves may ever run as a page: each response carries a sandboxing
 * content security policy and `nosniff`. Only raster images show inline. Every other part downloads,
 * whatever type the sender declared.
 */

/** What the Mailroom serves of a message's bytes. Null means the message or part is gone. */
export type MessageBytes = {
  source: (ref: MessageRef) => Promise<ReadableStream<Uint8Array> | null>;
  part: (
    ref: MessageRef,
    attachmentId: string,
  ) => Promise<{ body: ReadableStream<Uint8Array>; type: string; name: string } | null>;
};

export type MessageTarget = { ref: MessageRef; attachmentId?: string };

export async function serveMessageBytes(
  { ref, attachmentId }: MessageTarget,
  mailroom: MessageBytes,
): Promise<Response> {
  if (attachmentId === undefined) {
    const source = await mailroom.source(ref);
    if (!source) return notFound();
    return new Response(source, {
      headers: byteHeaders({ type: 'text/plain; charset=utf-8', name: 'message.eml' }),
    });
  }
  const part = await mailroom.part(ref, attachmentId);
  if (!part) return notFound();
  const image = rasterImage(part.type);
  return new Response(part.body, {
    headers: byteHeaders({
      type: image ?? mediaType(part.type) ?? 'application/octet-stream',
      name: part.name,
      download: !image,
    }),
  });
}

/** The image types every browser decodes as pictures and never as documents. */
const RASTER = new Set([
  'image/png',
  'image/apng',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/avif',
  'image/bmp',
]);

/** A declared type, if it is a raster image, as its bare media type. */
export function rasterImage(declared: string): string | undefined {
  const type = mediaType(declared);
  return type && RASTER.has(type) ? type : undefined;
}

/** The headers every response of a message's or a remote image's bytes carries. */
export function byteHeaders({
  type,
  name,
  download = false,
  cache = 'private, max-age=31536000, immutable',
}: {
  type: string;
  name: string;
  download?: boolean;
  cache?: string;
}): Headers {
  return new Headers({
    'content-type': type,
    'content-disposition': `${download ? 'attachment' : 'inline'}; ${filename(name)}`,
    // Opened directly, the bytes become an opaque document that runs nothing and loads nothing.
    'content-security-policy': "sandbox; default-src 'none'",
    'x-content-type-options': 'nosniff',
    // No other site may embed a member's mail, even though the request would carry the sign-in.
    'cross-origin-resource-policy': 'same-origin',
    'referrer-policy': 'no-referrer',
    'cache-control': cache,
  });
}

export function notFound(): Response {
  return new Response('Not found', {
    status: 404,
    headers: byteHeaders({
      type: 'text/plain; charset=utf-8',
      name: 'not-found.txt',
      cache: 'no-store',
    }),
  });
}

/** `type/subtype`, lowercased and without parameters, or undefined when it is not one. */
function mediaType(declared: string): string | undefined {
  const type = declared.split(';')[0]?.trim().toLowerCase() ?? '';
  return /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(type) ? type : undefined;
}

/** A file name a header can carry: plain ASCII as a fallback, and the name itself encoded. */
function filename(name: string): string {
  const clean = Array.from(name.replace(/[\\/]/g, '_'))
    .filter((char) => char >= ' ' && char !== '\u007f')
    .join('')
    .trim();
  const fallback = clean.replace(/[^\x20-\x7e]|"/g, '_') || 'attachment';
  return `filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(clean || 'attachment')}`;
}
