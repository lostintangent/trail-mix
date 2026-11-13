import { demoImage } from '../../features/providers/index.ts';
import { isPublicHost } from '../../shared/public-host.ts';
import { byteHeaders, rasterImage } from './messages.ts';

/**
 * `/images?url=<url>` loads a remote image that a message shows once the member allows its sender.
 * The remote host sees only Trail Mix's Worker: no address, no cookie and no referrer of the
 * member's. What comes back is served only if it is a raster image of a sane size, under the same
 * headers as a message's own bytes, so it can never run as a page.
 */

/** The largest remote image served. */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

/** How many redirects a remote image may take, each checked like the first address. */
const MAX_REDIRECTS = 5;

export async function proxyImage(
  request: Request,
  fetchRemote: typeof fetch = fetch,
): Promise<Response> {
  // Only Trail Mix's own pages, or the member opening an image directly, may use the proxy, so
  // another site can't use the member's sign-in to fetch the internet for it.
  const site = request.headers.get('sec-fetch-site');
  if (site && site !== 'same-origin' && site !== 'none') return refuse(403, 'Not from Trail Mix.');

  let target = remoteUrl(new URL(request.url).searchParams.get('url') ?? '');
  if (!target) return refuse(400, 'Not a remote image address.');

  let response: Response | undefined;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    response = await fetchRemote(target, {
      redirect: 'manual',
      headers: {
        accept: 'image/avif,image/webp,image/png,image/*;q=0.8',
        'user-agent': 'Trail Mix',
      },
      signal: AbortSignal.timeout(10_000),
    });
    const location = response.headers.get('location');
    if (response.status < 300 || response.status >= 400 || !location) break;
    await response.body?.cancel();
    target = remoteUrl(new URL(location, target).href);
    if (!target) return refuse(400, 'The image redirected somewhere it may not go.');
    response = undefined;
  }

  if (!response?.ok || !response.body) return refuse(502, 'The image could not be loaded.');
  const type = rasterImage(response.headers.get('content-type') ?? '');
  if (!type) {
    await response.body.cancel();
    return refuse(415, 'That is not an image.');
  }
  if (Number(response.headers.get('content-length') ?? 0) > MAX_IMAGE_BYTES) {
    await response.body.cancel();
    return refuse(413, 'The image is too large.');
  }
  return new Response(response.body.pipeThrough(limit(MAX_IMAGE_BYTES)), {
    headers: byteHeaders({ type, name: 'image', cache: 'private, max-age=86400' }),
  });
}

/**
 * The answer on a deployment that serves only the demo mailbox, whose images are at reserved
 * addresses that never resolve: the demo's own picture for an address its mail names, and nothing
 * for any other, so it fetches nothing from the internet for anyone.
 */
export function demoImages(request: Request): Response {
  const picture = demoImage(new URL(request.url).searchParams.get('url') ?? '');
  if (picture === undefined) return refuse(404, 'This Trail Mix loads no remote images.');
  return new Response(picture, {
    headers: byteHeaders({
      type: 'image/svg+xml',
      name: 'image.svg',
      cache: 'private, max-age=86400',
    }),
  });
}

/** An http or https address on the public internet, or null. */
export function remoteUrl(raw: string): URL | null {
  const url = URL.parse(raw);
  if (!url || (url.protocol !== 'http:' && url.protocol !== 'https:')) return null;
  if (url.username || url.password || !isPublicHost(url.hostname)) return null;
  return url;
}

/** Passes bytes through until there are more than `max`, then fails the stream. */
function limit(max: number): TransformStream<Uint8Array, Uint8Array> {
  let seen = 0;
  return new TransformStream({
    transform(chunk, controller) {
      seen += chunk.byteLength;
      if (seen > max) controller.error(new Error('The image is too large.'));
      else controller.enqueue(chunk);
    },
  });
}

function refuse(status: number, message: string): Response {
  return new Response(message, {
    status,
    headers: byteHeaders({
      type: 'text/plain; charset=utf-8',
      name: 'error.txt',
      cache: 'no-store',
    }),
  });
}
