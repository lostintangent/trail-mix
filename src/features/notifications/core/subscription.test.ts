import { describe, expect, test } from 'bun:test';
import { fromBase64Url, subscriptionOf, toBase64Url } from './subscription.ts';

const P256DH = toBase64Url(new Uint8Array([4, ...Array<number>(64).fill(7)]));
const AUTH = toBase64Url(new Uint8Array(16).fill(9));
const BROWSER = {
  endpoint: 'https://fcm.googleapis.com/fcm/send/abc',
  expirationTime: null,
  keys: { p256dh: P256DH, auth: AUTH },
};

describe('a subscription a browser sends', () => {
  test('is kept as its endpoint and keys, and nothing else it carried', () => {
    expect(subscriptionOf(BROWSER)).toEqual({
      endpoint: BROWSER.endpoint,
      keys: { p256dh: P256DH, auth: AUTH },
    });
  });

  test('is refused without an https endpoint', () => {
    for (const endpoint of [
      undefined,
      42,
      'not a url',
      'http://push.example/1',
      'javascript:alert(1)',
      `https://push.example/${'a'.repeat(2_048)}`,
    ]) {
      expect(() => subscriptionOf({ ...BROWSER, endpoint })).toThrow(TypeError);
    }
  });

  test('is refused without a P-256 public key and a 16-byte secret', () => {
    const compressed = toBase64Url(new Uint8Array([2, ...Array<number>(32).fill(7)]));
    for (const keys of [
      undefined,
      {},
      { p256dh: compressed, auth: AUTH },
      { p256dh: P256DH, auth: toBase64Url(new Uint8Array(8)) },
      { p256dh: 'not base64!', auth: AUTH },
    ]) {
      expect(() => subscriptionOf({ ...BROWSER, keys })).toThrow(TypeError);
    }
    expect(() => subscriptionOf(null)).toThrow(TypeError);
  });
});

test('base64url reads back what it wrote, padded or not', () => {
  const bytes = new Uint8Array([251, 255, 0, 62, 63]);
  expect(fromBase64Url(toBase64Url(bytes))).toEqual(bytes);
  expect(fromBase64Url(`${toBase64Url(bytes)}==`)).toEqual(bytes);
});
