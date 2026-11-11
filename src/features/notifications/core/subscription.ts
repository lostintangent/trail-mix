/** A device's push subscription, as its browser gave it: where to post, and the keys to encrypt for. */
export type Subscription = { endpoint: string; keys: { p256dh: string; auth: string } };

/**
 * A subscription a browser sent, checked: an https endpoint, a P-256 public key in its uncompressed
 * form and a 16-byte authentication secret, each base64url as `PushSubscription.toJSON()` writes
 * them. Anything else is refused, so nothing sealed for a device can be posted where it can't go.
 */
export function subscriptionOf(value: unknown): Subscription {
  const { endpoint, keys } = (value ?? {}) as { endpoint?: unknown; keys?: unknown };
  const { p256dh, auth } = (keys ?? {}) as { p256dh?: unknown; auth?: unknown };
  if (typeof endpoint !== 'string' || endpoint.length > 2_048 || !URL.canParse(endpoint)) {
    throw new TypeError('A device subscribes with its push service’s address.');
  }
  if (new URL(endpoint).protocol !== 'https:') {
    throw new TypeError('A push service is reached over HTTPS.');
  }
  if (
    bytesOf(p256dh)?.length !== 65 ||
    bytesOf(p256dh)?.[0] !== 4 ||
    bytesOf(auth)?.length !== 16
  ) {
    throw new TypeError('A device subscribes with the keys its browser made.');
  }
  return { endpoint, keys: { p256dh: p256dh as string, auth: auth as string } };
}

function bytesOf(value: unknown): Uint8Array | undefined {
  if (typeof value !== 'string' || !/^[\w-]+={0,2}$/.test(value)) return undefined;
  return fromBase64Url(value);
}

export function fromBase64Url(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, ''));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

export function toBase64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}
