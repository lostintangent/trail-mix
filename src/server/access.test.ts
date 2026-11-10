import { beforeAll, expect, test } from 'bun:test';
import {
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  SignJWT,
  type CryptoKey,
  type JWTVerifyGetKey,
} from 'jose';
import { signInFor, type SignInConfig } from './access.ts';

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

async function member(config: SignInConfig, request: Request) {
  const signIn = signInFor(config, certificates);
  if (!signIn) throw new Error('No sign-in is configured');
  return signIn(request);
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
