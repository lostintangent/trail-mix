import { fromBase64Url, toBase64Url, type Subscription } from '../core/subscription.ts';

/** What a stand-in push service received: the push, decrypted, and what its sender signed. */
export type Received = {
  /** The push's plaintext, parsed as JSON. */
  message: unknown;
  /** The VAPID token's claims, once its signature checked out against the key it names. */
  claims: { aud: string; sub: string; exp: number };
  /** The key the token names, which subscriptions are made for. */
  key: string;
  ttl: string | null;
  urgency: string | null;
};

/**
 * A push service for tests, and the one device subscribed through it. It decrypts each push as the
 * device would (RFC 8291), checks the VAPID token (RFC 8292), and answers with whatever status the
 * test sets, 201 until then. A push it can't decrypt or whose token doesn't verify throws.
 */
export async function standInPushService(endpoint = 'https://push.example/devices/1') {
  const device = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
    'deriveBits',
  ])) as CryptoKeyPair;
  const devicePublic = new Uint8Array(
    (await crypto.subtle.exportKey('raw', device.publicKey)) as ArrayBuffer,
  );
  const auth = crypto.getRandomValues(new Uint8Array(16));
  const received: Received[] = [];
  let status = 201;
  const subscription: Subscription = {
    endpoint,
    keys: { p256dh: toBase64Url(devicePublic), auth: toBase64Url(auth) },
  };
  return {
    subscription,
    received,
    answer: (next: number) => (status = next),
    post: async (request: Request): Promise<Response> => {
      if (request.url !== endpoint) throw new Error(`Posted to ${request.url}, not ${endpoint}.`);
      const body = new Uint8Array(await request.arrayBuffer());
      const plaintext = await decrypt(body, device.privateKey, devicePublic, auth);
      const { claims, key } = await verified(request.headers.get('authorization') ?? '');
      received.push({
        message: JSON.parse(new TextDecoder().decode(plaintext)) as unknown,
        claims,
        key,
        ttl: request.headers.get('ttl'),
        urgency: request.headers.get('urgency'),
      });
      return new Response(null, { status });
    },
  };
}

/** A push's plaintext, as the device decrypts it: one aes128gcm record (RFC 8188, RFC 8291). */
export async function decrypt(
  body: Uint8Array,
  devicePrivate: CryptoKey,
  devicePublic: Uint8Array,
  auth: Uint8Array,
): Promise<Uint8Array> {
  const salt = body.slice(0, 16);
  const keyLength = body[20]!;
  const senderPublic = body.slice(21, 21 + keyLength);
  const record = body.slice(21 + keyLength);
  const sender = await crypto.subtle.importKey(
    'raw',
    senderPublic,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    [],
  );
  // Workers' types name the member `$public`, for the binding, but it is `public` at run time.
  const ecdh = { name: 'ECDH', public: sender } as Parameters<SubtleCrypto['deriveBits']>[0];
  const shared = await crypto.subtle.deriveBits(ecdh, devicePrivate, 256);
  const keyInfo = concat(text('WebPush: info\0'), devicePublic, senderPublic);
  const ikm = await hkdf(auth, new Uint8Array(shared), keyInfo, 32);
  const cek = await hkdf(salt, ikm, text('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, text('Content-Encoding: nonce\0'), 12);
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']);
  const padded = new Uint8Array(
    await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, key, record),
  );
  // The last record ends at its 0x02 delimiter, and only zeroes pad it after that.
  let end = padded.length - 1;
  while (end >= 0 && padded[end] === 0) end--;
  if (padded[end] !== 2) throw new Error('The record has no last-record delimiter.');
  return padded.slice(0, end);
}

/** A VAPID header's token, verified against the key it names, and its claims. */
async function verified(authorization: string) {
  const [, token, key] = /^vapid t=([\w-]+\.[\w-]+\.[\w-]+), k=([\w-]+)$/.exec(authorization) ?? [];
  if (!token || !key) throw new Error(`Not a VAPID authorization: ${authorization}`);
  const [header, payload, signature] = token.split('.') as [string, string, string];
  const publicKey = await crypto.subtle.importKey(
    'raw',
    fromBase64Url(key),
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['verify'],
  );
  const signed = await crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    publicKey,
    fromBase64Url(signature),
    text(`${header}.${payload}`),
  );
  if (!signed) throw new Error('The VAPID token’s signature doesn’t match its key.');
  const claims = JSON.parse(new TextDecoder().decode(fromBase64Url(payload))) as Received['claims'];
  return { claims, key };
}

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, bytes: number) {
  const material = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: 'HKDF', hash: 'SHA-256', salt, info },
      material,
      bytes * 8,
    ),
  );
}

const text = (value: string) => new TextEncoder().encode(value);

function concat(...parts: Uint8Array[]): Uint8Array {
  const joined = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    joined.set(part, at);
    at += part.length;
  }
  return joined;
}
