import { buildPushPayload } from '@block65/webcrypto-web-push';
import type { PushMessage } from '../core/push.ts';
import { fromBase64Url, toBase64Url, type Subscription } from '../core/subscription.ts';

/**
 * Web Push from the Mailroom: a notice encrypted for one device (RFC 8291) and signed with the
 * deployment's key (VAPID, RFC 8292), posted to the push service that device subscribed through.
 */

/** The deployment's push key, base64url: its public half, and the private scalar that signs. */
export type PushKey = { publicKey: string; privateKey: string; subject: string };

/** How a push fared, which decides what happens to the device that was to receive it. */
type Delivery =
  /** The push service took it. */
  | 'sent'
  /** The subscription has ended, so the device is forgotten. */
  | 'gone'
  /** The push service refused the deployment's key. The device stays: the fault is ours. */
  | 'refused'
  /** Anything else, which costs this one notice and nothing more. */
  | 'failed';

/** How long a push service holds a notice for a device that's away. Apple requires one. */
const KEEP_S = 24 * 60 * 60;

/**
 * The push key in the deployment's `PUSH_KEY`, a P-256 private key in PKCS #8 PEM, as `openssl
 * genpkey` writes it, with its JWT subject: the operator's address, which push services contact.
 */
export async function pushKeyOf(pem: string, operator: string): Promise<PushKey> {
  const der = Uint8Array.from(atob(pem.replace(/-----[^-]+-----|\s/g, '')), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey(
    'pkcs8',
    der,
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign'],
  );
  const { d, x, y } = (await crypto.subtle.exportKey('jwk', key)) as JsonWebKey;
  if (!d || !x || !y) throw new Error('PUSH_KEY isn’t a P-256 private key.');
  const point = new Uint8Array([4, ...fromBase64Url(x), ...fromBase64Url(y)]);
  return { publicKey: toBase64Url(point), privateKey: d, subject: `mailto:${operator}` };
}

/** Posts a notice to one device, through `post`, which is `fetch` but in a test. */
export async function deliver(
  to: Subscription,
  message: PushMessage,
  key: PushKey,
  post: (request: Request) => Promise<Response> = fetch,
): Promise<Delivery> {
  const { method, headers, body } = await buildPushPayload(
    { data: message, options: { ttl: KEEP_S, urgency: 'normal' } },
    { endpoint: to.endpoint, expirationTime: null, keys: to.keys },
    key,
  );
  try {
    return deliveryOf((await post(new Request(to.endpoint, { method, headers, body }))).status);
  } catch {
    return 'failed';
  }
}

/** How a push fared, by the push service's answer (RFC 8030). */
function deliveryOf(status: number): Delivery {
  if (status >= 200 && status < 300) return 'sent';
  if (status === 404 || status === 410) return 'gone';
  if (status === 401 || status === 403) return 'refused';
  return 'failed';
}
