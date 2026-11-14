// Signing in to Outlook, on the local Workers runtime: the Mailroom's side of Microsoft's device-code
// sign-in, against the test mail server's outlook profile and its stand-in for Microsoft, which
// checks every XOAUTH2 login on IMAP and on submission.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { Account, Folder } from '../../mail/core/index.ts';
import { PRESETS } from '../../providers/index.ts';
import type { SignIn, SignInSetup } from '../client/contract.ts';
import {
  empty,
  identity,
  ports,
  start,
  stop,
  users,
} from '../../../../tests/mail-server/server.ts';
import type { Requested } from '../../../../tests/mail-server/sign-in.ts';
import { mailrooms, member } from '../../../../tests/mailrooms.ts';
import type { LocalWorker } from '../../../../tests/workerd.ts';

const { alice, bob } = users;
const outlook: SignInSetup = { preset: 'outlook', name: 'Outlook', address: alice.email };

/** Outlook, as a test reaches it: Microsoft's sign-in at the stand-in, and the test mail server. */
const OUTLOOK = {
  MICROSOFT_CLIENT_ID: 'trail-mix-test',
  OUTLOOK_STAND_IN: JSON.stringify({
    authority: identity.authority,
    imap: { host: 'localhost', port: ports.imaps, secure: true },
    smtp: { host: 'localhost', port: ports.submission, secure: false },
  }),
};

/** The stand-in's sign-in page, where a test plays the member: approving, as someone, or declining. */
async function atMicrosoft(code: string, as: Record<string, string>) {
  const response = await fetch(`${identity.origin}/devicelogin`, {
    method: 'POST',
    body: new URLSearchParams({ user_code: code, ...as }),
  });
  expect(response.status).toBe(204);
}

/** Every request the stand-in had: no code or token in any of them. */
const requests = async () => (await fetch(`${identity.origin}/requests`)).json<Requested[]>();

const refreshes = async () =>
  (await requests()).filter(({ grantType }) => grantType === 'refresh_token').length;

/** Anything shaped like the stand-in's device codes and tokens. */
const SECRET = /[0-9a-f]{32}/;

describe('Signing in to Outlook', () => {
  let worker: LocalWorker;

  beforeAll(async () => {
    await start('outlook');
    await empty(alice.email);
    worker = await mailrooms(OUTLOOK);
  }, 120_000);

  afterAll(async () => {
    worker?.stop();
    await stop();
  });

  /** A Mailroom of its own for each test. */
  const fresh = (name: string) => member(`${name}-${Date.now()}`, () => worker);

  /** Starts a sign-in, approves it as Alice, and waits until her account is ready. */
  async function signedIn(mailroom: ReturnType<typeof fresh>, as: Record<string, string> = {}) {
    const started = await mailroom.call<SignIn>('signIn', outlook);
    await atMicrosoft(started.code, { login_hint: alice.email, ...as });
    await mailroom.until(
      async () => (await mailroom.call<Account[]>('accounts'))[0]?.status === 'ready',
    );
    const [account] = await mailroom.call<Account[]>('accounts');
    return account!;
  }

  test('an account signs in with a code, then reads with a token, keeping only what’s sealed', async () => {
    const ada = fresh('ada');
    expect(await ada.call('signInPresets')).toEqual(['outlook']);
    const started = await ada.call<SignIn>('signIn', outlook);
    expect(started).toMatchObject({
      address: alice.email,
      link: `${identity.origin}/devicelogin`,
      state: 'waiting',
    });
    // The browser sees the code the member types, and never the device code that redeems it.
    expect(JSON.stringify(started)).not.toMatch(SECRET);
    expect(await ada.call('signIns')).toEqual([started]);

    await atMicrosoft(started.code, { login_hint: alice.email });
    await ada.until(async () => (await ada.call<Account[]>('accounts'))[0]?.status === 'ready');
    const accounts = await ada.call<Account[]>('accounts');
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({ name: 'Outlook', address: alice.email, preset: 'outlook' });
    expect(await ada.call('signIns')).toEqual([]);
    expect((await ada.call<Folder[]>('folders')).some(({ role }) => role === 'inbox')).toBe(true);

    // It asked to stay signed in, and holds that only sealed.
    const [asked] = (await requests())
      .filter(({ endpoint }) => endpoint === 'device code')
      .slice(-1);
    expect(asked?.scope?.split(' ')).toContain('offline_access');
    const stored = await ada.call<{ tables: Record<string, unknown[]> }>('stored');
    expect(stored.tables.credentials).toHaveLength(1);
    expect(stored.tables.sign_ins).toEqual([]);
    expect(JSON.stringify(stored.tables)).not.toMatch(SECRET);

    await expect(ada.call('signIn', outlook)).rejects.toThrow(
      `${alice.email} is already connected.`,
    );
  }, 60_000);

  test('a declined sign-in, or one Outlook refuses, keeps nothing but why', async () => {
    const bea = fresh('bea');
    const declined = await bea.call<SignIn>('signIn', outlook);
    await atMicrosoft(declined.code, { decline: '1' });
    await bea.until(async () => (await bea.call<SignIn[]>('signIns'))[0]?.state === 'refused');
    expect(await bea.call('signIns')).toEqual([
      { ...declined, state: 'refused', reason: 'You declined the sign-in at Microsoft.' },
    ]);

    // Signed in at Microsoft as Bob, for Alice's address: the token opens Bob's mail, not hers.
    const asBob = await bea.call<SignIn>('signIn', outlook);
    await atMicrosoft(asBob.code, { login_hint: bob.email });
    await bea.until(async () => (await bea.call<SignIn[]>('signIns'))[0]?.state === 'refused');
    const [refused] = await bea.call<(SignIn & { reason: string })[]>('signIns');
    expect(refused!.reason).toStartWith('localhost refused the sign-in');
    expect(refused!.reason).toEndWith(
      'If IMAP is off in Outlook.com’s settings, turn it on, then get a new code.',
    );
    expect(refused!.reason).not.toMatch(SECRET);

    expect(await bea.call('accounts')).toEqual([]);
    const stored = await bea.call<{ tables: Record<string, unknown[]> }>('stored');
    expect(stored.tables.credentials).toEqual([]);
    // Only the reason stays: the device code went when the sign-in stopped.
    expect(stored.tables.sign_ins).toHaveLength(1);
    expect(stored.tables.sign_ins?.[0]).toMatchObject({ sealed: null });
  }, 60_000);

  test('a sign-in the Mailroom restarts in the middle of still finishes', async () => {
    const cal = fresh('cal');
    const started = await cal.call<SignIn>('signIn', outlook);
    await cal.call('restart').catch(() => {});
    await atMicrosoft(started.code, { login_hint: alice.email });
    await cal.until(async () => (await cal.call<Account[]>('accounts'))[0]?.status === 'ready');
  }, 60_000);

  test('each connection gets a fresh token, and the refresh token kept is the newest', async () => {
    const dee = fresh('dee');
    // Tokens that last two seconds are never fresh enough to reuse, so every connection refreshes,
    // and each refresh spends the refresh token before it.
    await signedIn(dee, { expires_in: '2' });
    for (let round = 0; round < 2; round++) {
      const before = await refreshes();
      // A restart forgets every token in memory, and opening a device checks the account at once.
      await dee.call('restart').catch(() => {});
      const device = dee.device();
      await device.opened;
      await dee.until(async () => (await refreshes()) > before);
      await dee.until(async () => (await dee.call<Account[]>('accounts'))[0]?.status === 'ready');
      device.close();
    }
    expect((await requests()).filter(({ answer }) => answer === 'invalid_grant').length).toBe(0);
  }, 90_000);

  test('a revoked sign-in waits for its member, who signs the same account in again', async () => {
    const eve = fresh('eve');
    const account = await signedIn(eve, { expires_in: '2' });
    const inbox = (await eve.call<Folder[]>('folders')).find(({ role }) => role === 'inbox');

    await fetch(`${identity.origin}/revoke`, {
      method: 'POST',
      body: new URLSearchParams({ login_hint: alice.email }),
    });
    await eve.call('restart').catch(() => {});
    const device = eve.device();
    await device.opened;
    await eve.until(
      async () => (await eve.call<Account[]>('accounts'))[0]?.status === 'needs-sign-in',
    );
    // Nothing asks Microsoft again while it waits: not the open device, not another one opening,
    // and not a command that needs the server, which fails at once.
    const asked = await refreshes();
    const another = eve.device();
    await another.opened;
    await expect(
      eve.call('createFolder', { account: account.id, path: 'While signed out' }),
    ).rejects.toThrow('Sign in to Outlook again.');
    await Bun.sleep(5000);
    expect(await refreshes()).toBe(asked);
    expect((await eve.call<Account[]>('accounts'))[0]?.status).toBe('needs-sign-in');
    another.close();

    const again = await eve.call<SignIn>('signIn', account.id);
    expect(again).toMatchObject({ address: alice.email, account: account.id, state: 'waiting' });
    await atMicrosoft(again.code, { login_hint: alice.email });
    await eve.until(async () => (await eve.call<Account[]>('accounts'))[0]?.status === 'ready');
    const accounts = await eve.call<Account[]>('accounts');
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({ id: account.id, address: alice.email });
    expect((await eve.call<Folder[]>('folders')).find(({ role }) => role === 'inbox')).toEqual(
      inbox,
    );
    device.close();
  }, 90_000);
});

describe('Outlook, where it can’t sign in', () => {
  test('a stand-in with any address that isn’t this machine leaves Outlook as Microsoft’s', async () => {
    const standIn = JSON.parse(OUTLOOK.OUTLOOK_STAND_IN) as Record<string, unknown>;
    const elsewhere = { host: 'outlook.office365.com', port: 993, secure: true };
    for (const dressed of [
      { authority: 'https://login.evil.com/consumers' },
      { authority: 'https://127.0.0.1@login.evil.com/consumers' },
      { imap: elsewhere },
      { smtp: { ...elsewhere, port: 587, secure: false } },
    ]) {
      const worker = await mailrooms({
        ...OUTLOOK,
        OUTLOOK_STAND_IN: JSON.stringify({ ...standIn, ...dressed }),
      });
      try {
        const hal = member('hal', () => worker);
        expect(await hal.call('presetFrom', 'outlook')).toEqual(PRESETS.outlook);
      } finally {
        worker.stop();
      }
    }
    // And the stand-in the tests above use is honored, through the same path.
    const honored = await mailrooms(OUTLOOK);
    try {
      expect(await member('ida', () => honored).call('presetFrom', 'outlook')).toMatchObject({
        device: { authority: identity.authority },
        imap: { host: 'localhost', port: ports.imaps },
      });
    } finally {
      honored.stop();
    }
  }, 120_000);

  test('without the operator’s Microsoft app, or on a demo deployment, nothing reaches Microsoft', async () => {
    await start('outlook');
    const asked = (await requests()).length;
    const unset = await mailrooms({ OUTLOOK_STAND_IN: OUTLOOK.OUTLOOK_STAND_IN });
    const demo = await mailrooms({ ...OUTLOOK, DEMO_MAILBOX: '10' });
    try {
      const fay = member('fay', () => unset);
      expect(await fay.call('signInPresets')).toEqual([]);
      await expect(fay.call('signIn', outlook)).rejects.toThrow(
        'Microsoft sign-in isn’t set up on this Trail Mix. The operator registers an app with Microsoft and sets MICROSOFT_CLIENT_ID.',
      );
      const gus = member('gus', () => demo);
      expect(await gus.call('signInPresets')).toEqual([]);
      await expect(gus.call('signIn', outlook)).rejects.toThrow(
        'This Trail Mix serves only the demo mailbox, so it can’t connect an account of your own.',
      );
      expect((await requests()).length).toBe(asked);
    } finally {
      unset.stop();
      demo.stop();
      await stop();
    }
  }, 120_000);
});
