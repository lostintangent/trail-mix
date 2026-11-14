// The contract suite against the IMAP provider and the test mail server, once for each profile, so
// the provider meets the contract without QRESYNC and SPECIAL-USE, as on Zoho, without CONDSTORE,
// as on Outlook, and without UIDPLUS or MOVE, as on a plain IMAP server.
import { afterAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createServer, connect, type AddressInfo, type Socket } from 'node:net';
import { ImapFlow } from 'imapflow';
import nodemailer from 'nodemailer';
import { SendFailure } from '../../src/features/providers/index.ts';
import {
  checkSignIn,
  imapProvider,
  type ImapAccount,
  type Network,
} from '../../src/features/providers/imap/provider.ts';
import {
  DROP_AFTER_DATA_HEADER,
  caFile,
  count,
  empty,
  fileSentCopies,
  identity,
  kick,
  ports,
  profiles,
  resetUidValidity,
  settled,
  start,
  stop,
  users,
  type Profile,
} from '../mail-server/server.ts';
import { signedIn } from '../mail-server/sign-in.ts';
import { until } from '../until.ts';
import { describeContract, message, type Harness } from './contract.ts';

const { alice } = users;
const auth = { user: alice.email, pass: alice.password };
const ca = () => readFileSync(caFile, 'utf8');
const bytes = (raw: string) => new TextEncoder().encode(raw);
afterAll(stop);

/** The IMAP provider, signed in as alice at the test mail server, with what a case changes. */
const aliceAt = (account: Partial<ImapAccount> = {}, network: Network = {}) =>
  imapProvider(
    {
      account: 'test',
      imap: { host: 'localhost', port: ports.imaps, secure: true },
      smtp: { host: 'localhost', port: ports.submissions, secure: true },
      auth,
      ...account,
    },
    { ca: ca(), ...network },
  );

async function harness(profile: Profile): Promise<Harness> {
  await start(profile);
  const provider = aliceAt({ filesSent: profiles[profile].filesSent });

  // Another client of the same mailbox, for what happens elsewhere. A UIDVALIDITY reset makes the
  // server end every session, so it reconnects when it has to.
  let other: ImapFlow | undefined;
  async function elsewhere() {
    if (other?.usable) return other;
    other = new ImapFlow({
      host: 'localhost',
      port: ports.imaps,
      secure: true,
      auth,
      tls: { ca: [ca()] },
      logger: false,
    });
    other.on('error', () => {});
    await other.connect();
    return other;
  }

  return {
    provider,
    address: alice.email,
    filesSent: profiles[profile].filesSent,
    settle: () => (profiles[profile].filesSent ? settled() : Promise.resolve()),
    stopFilingSent: () => Promise.resolve(fileSentCopies(alice.email, 'never')),
    async reset() {
      // A copy still held from the last case is filed before the mailbox is emptied.
      await settled();
      await empty(alice.email);
      // The host files its own copies only when the case lets a moment pass.
      fileSentCopies(alice.email, profiles[profile].filesSent ? 'held' : undefined);
    },
    async deliver(raw, folder = 'INBOX') {
      await (await elsewhere()).append(folder, raw);
    },
    async expunge(folder, messageId) {
      const client = await elsewhere();
      const lock = await client.getMailboxLock(folder);
      try {
        const found = await client.search({ header: { 'message-id': messageId } }, { uid: true });
        if (Array.isArray(found) && found.length) await client.messageDelete(found, { uid: true });
      } finally {
        lock.release();
      }
    },
    async resetUidValidity(folder) {
      await resetUidValidity(alice.email, folder);
      // The server ends a session whose folder was renumbered at its next command.
      other?.close();
      other = undefined;
    },
    async submit(raw) {
      const transport = nodemailer.createTransport({
        host: 'localhost',
        port: ports.submissions,
        secure: true,
        auth,
        tls: { ca: [ca()] },
      });
      await transport.sendMail({ envelope: { from: alice.email, to: [alice.email] }, raw });
      transport.close();
    },
    async close() {
      await provider.close();
      await other?.logout();
    },
  };
}

for (const profile of Object.keys(profiles) as Profile[]) {
  // Over TLS to a real server, a case such as filling a folder with 520 messages takes about
  // 5 seconds on a CI runner, Bun's whole default.
  describeContract(`The IMAP provider on the ${profile} profile`, () => harness(profile), {
    timeout: 30_000,
  });
}

describe('The IMAP provider', () => {
  const smtpAt = (port: number, secure = true) => ({ smtp: { host: 'localhost', port, secure } });
  /**
   * Saves a draft and submits it through `sending`, which fails. Says how it failed, how long the
   * submit took, and how often the message arrived.
   */
  async function failedSubmit(
    fields: { id: string; to?: string; extra?: string },
    sending = aliceAt(),
  ) {
    await start('full');
    await empty(alice.email);
    const raw = message({
      id: fields.id,
      subject: fields.id,
      from: alice.email,
      to: fields.to ?? alice.email,
    });
    const draft = await sending.saveDraft(bytes(fields.extra ? `${fields.extra}\r\n${raw}` : raw));
    const started = Date.now();
    const failure = await sending
      .submit(draft, `<${fields.id}@example.com>`)
      .catch((e: unknown) => e);
    const took = Date.now() - started;
    await sending.close();
    expect(failure).toBeInstanceOf(SendFailure);
    return {
      failure: failure as SendFailure,
      took,
      delivered: await count(alice.email, 'INBOX'),
      drafts: await count(alice.email, 'Drafts'),
    };
  }

  test('a submit the host refuses fails for good, and delivers nothing', async () => {
    const { failure, delivered, drafts } = await failedSubmit({
      id: 'refused',
      to: 'someone@example.com',
    });
    expect(failure.passing).toBe(false);
    expect(failure.message).toMatch(/^localhost refused it: 550 /);
    expect({ delivered, drafts }).toEqual({ delivered: 0, drafts: 1 });
  }, 30_000);

  test('a submit that cannot reach the host fails for now, and delivers nothing', async () => {
    const unreachable = aliceAt(smtpAt(ports.lmtp + 1));
    const { failure, delivered } = await failedSubmit({ id: 'unreachable' }, unreachable);
    expect(failure.passing).toBe(true);
    expect(failure.message).toMatch(/^Couldn’t reach localhost: /);
    expect(delivered).toBe(0);
  }, 30_000);

  // A host that accepts the connection and then says nothing, during TLS or after its greeting.
  for (const [quiet, smtp] of [
    ['during TLS', { secure: true, greets: false }],
    ['after its greeting', { secure: false, greets: true }],
  ] as const) {
    test(`a submit to a host that goes quiet ${quiet} fails for now, after a while`, async () => {
      const host = Bun.listen({
        hostname: 'localhost',
        port: 0,
        socket: {
          open: (socket) => void (smtp.greets && socket.write('220 Busy ESMTP\r\n')),
          data() {},
        },
      });
      try {
        const quietHost = aliceAt(smtpAt(host.port, smtp.secure), { patience: 1000 });
        const { failure, took } = await failedSubmit({ id: 'quiet' }, quietHost);
        expect(took).toBeLessThan(5000);
        expect(failure.passing).toBe(true);
        expect(failure.message).toMatch(/^Couldn’t reach localhost: /);
      } finally {
        host.stop(true);
      }
    }, 30_000);
  }

  test('a submit whose connection drops after the message went out says it may have gone', async () => {
    const { failure, delivered } = await failedSubmit({
      id: 'dropped',
      extra: DROP_AFTER_DATA_HEADER,
    });
    expect(failure.passing).toBe(false);
    expect(failure.message).toContain('so it may have been delivered');
    expect(delivered).toBe(1);
  }, 30_000);

  test('a command on a connection gone quiet runs again on a new one, after a while', async () => {
    await start('full');
    await empty(alice.email);
    const relay = quietable(ports.imaps);
    const reading = aliceAt(
      { imap: { host: 'localhost', port: await relay.port, secure: true } },
      { patience: 1000 },
    );
    try {
      const raw = message({
        id: 'quiet-read',
        subject: 'Quiet',
        from: alice.email,
        to: alice.email,
      });
      const draft = await reading.saveDraft(bytes(raw));
      // The connection the draft was saved on stays open, and the server says nothing more on it.
      relay.quiet();
      const started = Date.now();
      const body = await new Response(await reading.body(draft)).text();
      expect(Date.now() - started).toBeLessThan(5000);
      expect(body).toContain('Subject: Quiet');
    } finally {
      await reading.close();
      relay.stop();
    }
  }, 30_000);

  test('watches again after the server drops it, and reports what it may have missed', async () => {
    await start('full');
    await empty(alice.email);
    const provider = aliceAt();
    let changes = 0;
    const stop = provider.watch('INBOX', () => changes++);
    await Bun.sleep(1000);
    await kick(alice.email);
    await until(() => changes > 0, 10_000);
    stop();
    await provider.close();
  }, 30_000);
});

describe('The IMAP provider, signed in with a token', () => {
  const { bob } = users;
  // As Outlook does: XOAUTH2 over IMAP, and over submission's STARTTLS on 587.
  const outlook = (accessToken: () => Promise<string>, user = alice.email) => ({
    account: 'test',
    imap: { host: 'localhost', port: ports.imaps, secure: true },
    smtp: { host: 'localhost', port: ports.submission, secure: false },
    auth: { user, accessToken },
    filesSent: true,
  });

  test('asks for a token for each new connection, so one that ran out costs only a reconnect', async () => {
    await start('outlook');
    await empty(alice.email);
    const tokens = await signedIn(identity.origin, alice.email, 2);
    const asked: string[] = [];
    const provider = imapProvider(
      outlook(async () => {
        asked.push(await tokens.fresh());
        return asked.at(-1)!;
      }),
      { ca: ca() },
    );
    try {
      expect((await provider.folders()).length).toBeGreaterThan(0);
      expect(asked).toHaveLength(1);
      // The token runs out, and the server ends the session. The next command signs in again.
      await Bun.sleep(2_500);
      await kick(alice.email);
      expect((await provider.folders()).length).toBeGreaterThan(0);
      expect(asked).toHaveLength(2);

      const raw = message({ id: 'token', subject: 'token', from: alice.email, to: alice.email });
      const draft = await provider.saveDraft(bytes(raw));
      await provider.submit(draft, '<token@example.com>');
      expect(asked).toHaveLength(3);
      await settled();
      expect(await count(alice.email, 'INBOX')).toBe(1);
    } finally {
      await provider.close();
    }
  }, 30_000);

  test('checking the sign-in takes a good token, and refuses another person’s without repeating it', async () => {
    await start('outlook');
    const alices = await signedIn(identity.origin, alice.email);
    await checkSignIn(outlook(alices.fresh), { ca: ca() });

    const bobs = await signedIn(identity.origin, bob.email);
    const given: string[] = [];
    const refused = await checkSignIn(
      outlook(async () => {
        given.push(await bobs.fresh());
        return given.at(-1)!;
      }),
      { ca: ca() },
    ).then(
      () => 'kept',
      (error: Error) => error.message,
    );
    expect(refused).toStartWith('localhost refused the sign-in');
    expect(given).toHaveLength(1);
    expect(refused).not.toContain(given[0]!);
  }, 30_000);

  test('a token that can’t be had fails the sign-in as it failed, not as the host refusing it', async () => {
    await start('outlook');
    const lapsed = new Error('The sign-in has lapsed.');
    const failed = await checkSignIn(
      outlook(() => Promise.reject(lapsed)),
      { ca: ca() },
    ).catch((error: unknown) => error);
    expect(failed).toBe(lapsed);
  }, 30_000);
});

/**
 * A relay to `port` that can fall quiet: from then on, the connections open through it stay open
 * and pass nothing either way, as a connection does when the network under it goes. Connections
 * made later pass as before.
 */
function quietable(port: number) {
  const open: { client: Socket; server: Socket }[] = [];
  const relay = createServer((client) => {
    const server = connect(port, 'localhost');
    client.pipe(server);
    server.pipe(client);
    const close = () => {
      client.destroy();
      server.destroy();
    };
    client.on('error', close).on('close', close);
    server.on('error', close).on('close', close);
    open.push({ client, server });
  });
  const listening = new Promise<number>((resolve) =>
    relay.listen(0, 'localhost', () => resolve((relay.address() as AddressInfo).port)),
  );
  return {
    port: listening,
    quiet() {
      for (const { client, server } of open) {
        client.unpipe(server);
        server.unpipe(client);
        client.pause();
        server.pause();
      }
    },
    stop() {
      relay.close();
      for (const { client, server } of open) {
        client.destroy();
        server.destroy();
      }
    },
  };
}
