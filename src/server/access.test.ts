import { beforeAll, describe, expect, test } from 'bun:test';
import {
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  SignJWT,
  type CryptoKey,
  type JWTVerifyGetKey,
} from 'jose';
import {
  networkOf,
  signInFor,
  signsInDevelopers,
  VISITOR_SECONDS,
  type Signed,
  type SignInConfig,
} from './access.ts';

const TEAM = 'trailmix.cloudflareaccess.com';
const AUD = 'trail-mix-application';
const ACCESS: SignInConfig = { ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD };

/** The keys Access signs with, as its certificates publish them, and a key it never published. */
let accessKey: CryptoKey;
let strangerKey: CryptoKey;
let certificates: JWTVerifyGetKey;

beforeAll(async () => {
  const access = await generateKeyPair('RS256');
  accessKey = access.privateKey;
  strangerKey = (await generateKeyPair('RS256')).privateKey;
  certificates = createLocalJWKSet({
    keys: [{ ...(await exportJWK(access.publicKey)), kid: 'access', alg: 'RS256' }],
  });
});

/** A token as Access would sign it, with any claim or key changed. */
function token({
  email = 'ada@example.com',
  issuer = `https://${TEAM}`,
  audience = AUD,
  expires = '5m',
  key = () => accessKey,
}: {
  email?: string;
  issuer?: string;
  audience?: string;
  expires?: string | number;
  key?: () => CryptoKey;
} = {}) {
  return new SignJWT({ email })
    .setProtectedHeader({ alg: 'RS256', kid: 'access' })
    .setIssuer(issuer)
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime(expires)
    .sign(key());
}

const request = (headers: Record<string, string> = {}, url = 'https://mail.example.com/') =>
  new Request(url, { headers });

/** Who a request signs in as, or nothing when sign-in answers it with a refusal. */
async function member(config: SignInConfig, request: Request, reachesMailroom = true) {
  const signIn = signInFor(config, certificates);
  if (!signIn) throw new Error('No sign-in is configured');
  const signed = await signIn(request, { reachesMailroom });
  return signed instanceof Response ? undefined : signed.member;
}

test('a token Access signed for this application names its member', async () => {
  const signed = await token({ email: 'Ada@Example.com' });

  expect(await member(ACCESS, request({ 'Cf-Access-Jwt-Assertion': signed }))).toBe(
    'ada@example.com',
  );
});

test('only A to Z fold, so an address in another script keeps its own Mailroom', async () => {
  const kelvin = await token({ email: 'Mar\u212Aus@example.com' });

  expect(await member(ACCESS, request({ 'Cf-Access-Jwt-Assertion': kelvin }))).toBe(
    'mar\u212Aus@example.com',
  );
});

test('what a browser can say for itself names nobody', async () => {
  const claims = {
    'Cf-Access-Authenticated-User-Email': 'ada@example.com',
    Cookie: 'CF_Authorization=ada@example.com',
  };

  expect(await member(ACCESS, request(claims))).toBeUndefined();
  expect(await member(ACCESS, request({ 'Cf-Access-Jwt-Assertion': 'ada@example.com' }))).toBe(
    undefined,
  );
});

test('a token Access didn’t sign for this application, or that ran out, names nobody', async () => {
  const forged = [
    await token({ key: () => strangerKey }),
    await token({ audience: 'another-application' }),
    await token({ issuer: 'https://another.cloudflareaccess.com' }),
    await token({ expires: Math.floor(Date.now() / 1000) - 60 }),
  ];

  for (const signed of forged) {
    expect(await member(ACCESS, request({ 'Cf-Access-Jwt-Assertion': signed }))).toBeUndefined();
  }
});

test('an unsigned token names nobody', async () => {
  const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url');
  const claims = Buffer.from(
    JSON.stringify({ email: 'ada@example.com', iss: `https://${TEAM}`, aud: AUD }),
  ).toString('base64url');

  expect(
    await member(ACCESS, request({ 'Cf-Access-Jwt-Assertion': `${header}.${claims}.` })),
  ).toBeUndefined();
});

test('the development member signs in only on localhost', async () => {
  const development = { DEV_MEMBER: 'Dev@TrailMix.test' };

  expect(await member(development, request({}, 'http://localhost:5173/'))).toBe(
    'dev@trailmix.test',
  );
  expect(await member(development, request({}, 'http://127.0.0.1:8787/'))).toBe(
    'dev@trailmix.test',
  );
  expect(await member(development, request({}, 'http://[::1]:5173/'))).toBe('dev@trailmix.test');
  expect(await member(development, request({}, 'https://mail.example.com/'))).toBeUndefined();
  expect(
    await member(development, request({}, 'http://localhost.attacker.example/')),
  ).toBeUndefined();
});

test('once Access is configured, the development member is gone', async () => {
  const both = { ...ACCESS, DEV_MEMBER: 'dev@trailmix.test' };

  expect(await member(both, request({}, 'http://localhost:5173/'))).toBeUndefined();
});

test('a deployment with no sign-in configured has no way to sign in', () => {
  expect(signInFor({})).toBeUndefined();
  expect(signInFor({ ACCESS_TEAM_DOMAIN: TEAM })).toBeUndefined();
  expect(signInFor({ ACCESS_AUD: AUD })).toBeUndefined();
});

describe('a visitor to the public demo', () => {
  const KEY = 'a-demo-key-that-is-at-least-32-characters';
  /** A gate that lets everyone in, and remembers who asked from where. */
  const gate = (admits = true) => {
    const asked: [string, string][] = [];
    return {
      asked,
      admit: (visitor: string, network: string) => {
        asked.push([visitor, network]);
        return Promise.resolve(admits);
      },
    };
  };
  const demo = (VISITOR_GATE = gate()): SignInConfig => ({
    VISITOR_KEY: KEY,
    DEMO_MAILBOX: '200',
    VISITOR_GATE,
    DEV_MEMBER: 'dev@trailmix.test',
  });
  const DEMO = 'https://demo.example.com/';
  async function visit(config: SignInConfig, cookie?: string, reachesMailroom = true) {
    const headers: Record<string, string> = { 'CF-Connecting-IP': '203.0.113.7' };
    if (cookie) headers.Cookie = cookie;
    return signInFor(config)!(request(headers, DEMO), { reachesMailroom });
  }
  const cookieOf = (signed: Signed | Response) => (signed as Signed).setCookie!.split(';')[0]!;

  test('comes in as a random visitor on demo.invalid, and stays the same one with their cookie', async () => {
    const config = demo();
    const first = (await visit(config)) as Signed;
    expect(first.member).toMatch(/^[0-9a-f]{32}@demo\.invalid$/);
    expect(first.setCookie).toMatch(
      new RegExp(
        `^__Host-visitor=[0-9a-f]{32}\\.in\\.[\\w-]{43}; Max-Age=${VISITOR_SECONDS}; Path=/; Secure; HttpOnly; SameSite=Lax$`,
      ),
    );
    const again = (await visit(config, `other=1; ${cookieOf(first)}`)) as Signed;
    expect(again.member).toBe(first.member);
    // Each answer sets the cookie again, so it lasts from the visitor's last request.
    expect(cookieOf(again)).toBe(cookieOf(first));
    // A browser that drops its cookie comes back as somebody new.
    expect(((await visit(config)) as Signed).member).not.toBe(first.member);
  });

  test('can’t name another visitor, or stay one, with a cookie the demo didn’t sign', async () => {
    const config = demo();
    const real = cookieOf(await visit(config));
    const [name, value] = real.split('=') as [string, string];
    const [id, state, signature] = value.split('.') as [string, string, string];
    const someoneElse = `${'0'.repeat(31)}1`;
    const forged = [
      `${name}=${someoneElse}.${state}.${signature}`,
      `${name}=${id}.${state}.${signature.slice(0, -2)}AA`,
      `${name}=${id}.${state}`,
      `${name}=${id.toUpperCase()}.${state}.${signature}`,
      `visitor=${value}`,
    ];
    for (const cookie of forged) {
      const signed = (await visit(config, cookie)) as Signed;
      expect(signed.member).not.toContain(someoneElse);
      expect(signed.member).not.toBe(`${id}@demo.invalid`);
    }
    // Another demo's key signs nobody here.
    const elsewhere = cookieOf(await visit({ ...demo(), VISITOR_KEY: `${KEY}-elsewhere` }));
    const elsewhereId = elsewhere.split('=')[1]!.split('.')[0]!;
    expect(((await visit(config, elsewhere)) as Signed).member).not.toBe(
      `${elsewhereId}@demo.invalid`,
    );
  });

  test('asks the gate once, from their network, before their first request reaches a Mailroom', async () => {
    const asks = gate();
    const config = demo(asks);
    // Serving the page asks nothing, and makes no Mailroom.
    const page = await visit(config, undefined, false);
    expect(asks.asked).toEqual([]);
    expect(cookieOf(page)).toContain('.new.');
    const member = (page as Signed).member;
    const query = (await visit(config, cookieOf(page))) as Signed;
    expect(query.member).toBe(member);
    expect(asks.asked).toEqual([[member.split('@')[0]!, '203.0.113.7']]);
    expect(cookieOf(query)).toContain('.in.');
    await visit(config, cookieOf(query));
    expect(asks.asked).toHaveLength(1);
    // A visitor can't say they're in: their cookie's state is signed with their id.
    const claimed = cookieOf(page).replace('.new.', '.in.');
    await visit(config, claimed);
    expect(asks.asked).toHaveLength(2);
  });

  test('finds the demo full for now when the gate says no, and is named nobody', async () => {
    const config = demo(gate(false));
    const refused = await visit(config);
    expect(refused).toBeInstanceOf(Response);
    const response = refused as Response;
    expect([response.status, response.headers.get('Content-Type')]).toEqual([
      429,
      'text/html; charset=utf-8',
    ]);
    expect(await response.text()).toContain('Trail Mix’s demo is full for now');
    // The page still loads, for the app to say so too.
    expect(await visit(config, undefined, false)).not.toBeInstanceOf(Response);
  });

  test('come in only on a deployment of the demo mailbox alone, with its gate, and never behind Access', async () => {
    expect(signInFor({ ...demo(), DEMO_MAILBOX: '', DEV_MEMBER: '' })).toBeUndefined();
    expect(signInFor({ ...demo(), VISITOR_GATE: undefined, DEV_MEMBER: '' })).toBeUndefined();
    expect(await member({ ...demo(), ...ACCESS }, request({}, DEMO))).toBeUndefined();
    // The development member gives way to visitors.
    expect(signsInDevelopers(demo())).toBe(false);
    expect(await member(demo(), request({}, 'http://localhost:5173/'))).toMatch(/@demo\.invalid$/);
    expect(() => signInFor({ ...demo(), VISITOR_KEY: 'short' })).toThrow('at least 32 characters');
  });
});

test('the network a visitor comes from is their IPv4 address, or their IPv6 /64', () => {
  expect(networkOf('203.0.113.7')).toBe('203.0.113.7');
  expect(networkOf('2001:db8:85a3:0042:1000:8a2e:0370:7334')).toBe('2001:db8:85a3:42::/64');
  expect(networkOf('2001:DB8::1')).toBe('2001:db8:0:0::/64');
  expect(networkOf('2001:db8:1:2::')).toBe('2001:db8:1:2::/64');
  expect(networkOf('::1')).toBe('0:0:0:0::/64');
  expect(networkOf('')).toBe('');
});
