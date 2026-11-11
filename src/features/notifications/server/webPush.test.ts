import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { encryptNotification } from '@block65/webcrypto-web-push';
import { pushOf } from '../core/push.ts';
import { fromBase64Url } from '../core/subscription.ts';
import { decrypt, standInPushService } from './test-push-service.ts';
import { deliver, pushKeyOf } from './webPush.ts';

afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
});
const spies: { mockRestore(): void }[] = [];

const NOTICE = {
  title: 'Ada Park',
  body: 'Trip photos',
  tag: 'personal:mail:1',
  navigate: '/?open=personal:mail:1',
};

describe('a push', () => {
  test('is sealed as RFC 8291’s worked example seals it, byte for byte', async () => {
    // The example's keys and salt, which a real push draws at random.
    const rfc = {
      auth: 'BTBZMqHH6r4Tts7J_aSIgg',
      receiver: {
        d: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
        public:
          'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
      },
      sender: {
        d: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
        public:
          'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
      },
      salt: 'DGv6ra1nlYgDCS1FRnbzlw',
      body:
        'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml' +
        'mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT' +
        'pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
    };
    const plaintext = new TextEncoder().encode('When I grow up, I want to be a watermelon');
    const sender = {
      privateKey: await ecdhKey(rfc.sender.d, rfc.sender.public),
      publicKey: await crypto.subtle.importKey(
        'raw',
        fromBase64Url(rfc.sender.public),
        { name: 'ECDH', namedCurve: 'P-256' },
        true,
        [],
      ),
    };
    spies.push(
      spyOn(crypto.subtle, 'generateKey').mockResolvedValue(sender),
      spyOn(crypto, 'getRandomValues').mockImplementation(
        <T extends ArrayBufferView | null>(array: T) => {
          (array as unknown as Uint8Array).set(fromBase64Url(rfc.salt));
          return array;
        },
      ),
    );
    const sealed = await encryptNotification(
      {
        endpoint: 'https://push.example.net/push/JzLQ3raZJfFBR0aqvOMsLrt54w4rJUsV',
        expirationTime: null,
        keys: { p256dh: rfc.receiver.public, auth: rfc.auth },
      },
      plaintext,
      { pad: false },
    );
    expect(sealed).toEqual(fromBase64Url(rfc.body));
    // The stand-in device opens the example as the RFC says it reads.
    const opened = await decrypt(
      fromBase64Url(rfc.body),
      await ecdhKey(rfc.receiver.d, rfc.receiver.public),
      fromBase64Url(rfc.receiver.public),
      fromBase64Url(rfc.auth),
    );
    expect(opened).toEqual(plaintext);
  });

  test('reaches the device sealed for it, signed with the deployment’s key for a day at most', async () => {
    const service = await standInPushService();
    const key = await pushKeyOf(await pemOf(), 'operator@example.com');
    const before = Math.floor(Date.now() / 1000);
    expect(await deliver(service.subscription, pushOf(NOTICE), key, service.post)).toBe('sent');
    const [received] = service.received;
    expect(received?.message).toEqual(pushOf(NOTICE));
    expect(received?.key).toBe(key.publicKey);
    expect(received?.claims).toMatchObject({
      aud: 'https://push.example',
      sub: 'mailto:operator@example.com',
    });
    expect(received!.claims.exp).toBeGreaterThan(before);
    expect(received!.claims.exp).toBeLessThanOrEqual(before + 24 * 60 * 60);
    expect([received?.ttl, received?.urgency]).toEqual(['86400', 'normal']);
  });

  test('is padded, so its size says nothing of what it says', async () => {
    const service = await standInPushService();
    const sizes: number[] = [];
    const post = async (request: Request) => {
      sizes.push((await request.clone().arrayBuffer()).byteLength);
      return service.post(request);
    };
    const key = await pushKeyOf(await pemOf(), 'operator@example.com');
    for (const body of ['Hi', 'A much longer preview of what the message says, word after word.']) {
      await deliver(service.subscription, pushOf({ ...NOTICE, body }), key, post);
    }
    expect(sizes[0]).toBe(sizes[1]);
  });

  test('fares by the push service’s answer, which decides what becomes of the device', async () => {
    const service = await standInPushService();
    const key = await pushKeyOf(await pemOf(), 'operator@example.com');
    const fared = async (status: number) => {
      service.answer(status);
      return deliver(service.subscription, pushOf(NOTICE), key, service.post);
    };
    expect(await fared(202)).toBe('sent');
    expect(await fared(404)).toBe('gone');
    expect(await fared(410)).toBe('gone');
    expect(await fared(401)).toBe('refused');
    expect(await fared(403)).toBe('refused');
    expect(await fared(413)).toBe('failed');
    expect(await fared(429)).toBe('failed');
    expect(await fared(503)).toBe('failed');
    const unreachable = () => Promise.reject(new TypeError('fetch failed'));
    expect(await deliver(service.subscription, pushOf(NOTICE), key, unreachable)).toBe('failed');
  });
});

describe('the deployment’s push key', () => {
  test('reads as openssl genpkey writes it, as the deploy makes it', async () => {
    const made = Bun.spawnSync([
      'openssl',
      'genpkey',
      '-algorithm',
      'EC',
      '-pkeyopt',
      'ec_paramgen_curve:P-256',
    ]);
    expect(made.exitCode).toBe(0);
    const key = await pushKeyOf(made.stdout.toString(), 'operator@example.com');
    expect(fromBase64Url(key.publicKey)).toHaveLength(65);
    expect(fromBase64Url(key.privateKey)).toHaveLength(32);
    expect(key.subject).toBe('mailto:operator@example.com');
  });

  test('gives the public half browsers subscribe with', async () => {
    const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
      'sign',
      'verify',
    ])) as CryptoKeyPair;
    const key = await pushKeyOf(await pemOf(pair.privateKey), 'operator@example.com');
    expect(fromBase64Url(key.publicKey)).toEqual(
      new Uint8Array((await crypto.subtle.exportKey('raw', pair.publicKey)) as ArrayBuffer),
    );
  });

  test('refuses a key that isn’t P-256', async () => {
    const other = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-384' }, true, [
      'sign',
    ])) as CryptoKeyPair;
    await expect(
      pushKeyOf(await pemOf(other.privateKey), 'operator@example.com'),
    ).rejects.toThrow();
  });
});

/** A private key as PEM, a new P-256 one unless given. */
async function pemOf(key?: CryptoKey): Promise<string> {
  const privateKey =
    key ??
    (
      (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
        'sign',
      ])) as CryptoKeyPair
    ).privateKey;
  const der = new Uint8Array((await crypto.subtle.exportKey('pkcs8', privateKey)) as ArrayBuffer);
  const lines = btoa(String.fromCharCode(...der)).match(/.{1,64}/g)!;
  return ['-----BEGIN PRIVATE KEY-----', ...lines, '-----END PRIVATE KEY-----', ''].join('\n');
}

/** A P-256 ECDH private key from its scalar and uncompressed public point, base64url. */
function ecdhKey(d: string, point: string): Promise<CryptoKey> {
  const bytes = fromBase64Url(point);
  const coordinate = (from: number) =>
    btoa(String.fromCharCode(...bytes.slice(from, from + 32)))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
  return crypto.subtle.importKey(
    'jwk',
    { kty: 'EC', crv: 'P-256', d, x: coordinate(1), y: coordinate(33) },
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    ['deriveBits'],
  );
}
