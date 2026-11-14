/**
 * Credentials at rest. A secret is sealed with AES-GCM under a key derived for one member from the
 * Worker secret, so one member's sealed secrets mean nothing under another member's key. Whoever
 * holds the Worker secret can open them all, which is why the operator is trusted.
 */

const INFO = new TextEncoder().encode('Trail Mix credentials, v1');

export type Credentials = ReturnType<typeof credentialsOf>;

/** One member's credentials: their key is derived once, on first use, and kept for the Mailroom's life. */
export function credentialsOf(workerSecret: string | undefined, member: string) {
  let key: Promise<CryptoKey> | undefined;
  const keyOf = (): Promise<CryptoKey> => {
    if (!workerSecret) return Promise.reject(new Error('The operator hasn’t set CREDENTIALS_KEY.'));
    key ??= memberKey(workerSecret, member);
    return key;
  };
  return {
    async seal(secret: string, account: string): Promise<Uint8Array> {
      return seal(await keyOf(), secret, account);
    },
    async open(sealed: Uint8Array, account: string): Promise<string> {
      return open(await keyOf(), sealed, account);
    },
  };
}

/** The member's key: HKDF over the Worker secret, salted with the member's Mailroom id. */
async function memberKey(workerSecret: string, member: string): Promise<CryptoKey> {
  if (workerSecret.length < 32) throw new Error('CREDENTIALS_KEY must be at least 32 characters.');
  const material = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(workerSecret),
    'HKDF',
    false,
    ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new TextEncoder().encode(member), info: INFO },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/** The secret, sealed: a fresh 12-byte nonce, then the ciphertext and its tag. */
async function seal(key: CryptoKey, secret: string, account: string): Promise<Uint8Array> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt(
      // The account is bound in, so a sealed secret cannot be moved to another account's row.
      { name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(account) },
      key,
      new TextEncoder().encode(secret),
    ),
  );
  const out = new Uint8Array(iv.length + sealed.length);
  out.set(iv);
  out.set(sealed, iv.length);
  return out;
}

async function open(key: CryptoKey, sealed: Uint8Array, account: string): Promise<string> {
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: sealed.slice(0, 12), additionalData: new TextEncoder().encode(account) },
    key,
    sealed.slice(12),
  );
  return new TextDecoder().decode(plain);
}
