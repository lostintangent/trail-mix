// The contract suite against the IMAP provider and the test mail server, once for each profile, so
// the provider meets the contract without QRESYNC and SPECIAL-USE, as on Zoho, without CONDSTORE,
// as on Outlook, and without UIDPLUS or MOVE, as on a plain IMAP server.
import { afterAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { ImapFlow } from 'imapflow';
import nodemailer from 'nodemailer';
import { SendFailure } from '../../src/features/providers/index.ts';
import { imapProvider } from '../../src/features/providers/imap/provider.ts';
import {
  DROP_AFTER_DATA_HEADER,
  caFile,
  count,
  empty,
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
import { describeContract, message, type Harness } from './contract.ts';

const { alice } = users;
const auth = { user: alice.email, pass: alice.password };
afterAll(stop);

async function harness(profile: Profile): Promise<Harness> {
  await start(profile);
  const ca = readFileSync(caFile, 'utf8');
  const provider = imapProvider(
    {
      account: 'test',
      imap: { host: 'localhost', port: ports.imaps, secure: true },
      smtp: { host: 'localhost', port: ports.submissions, secure: true },
      auth,
      filesSent: profiles[profile].filesSent,
    },
    { ca },
  );

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
      tls: { ca: [ca] },
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
    reset: () => empty(alice.email),
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
        tls: { ca: [ca] },
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
  const bytes = (raw: string) => new TextEncoder().encode(raw);
  const provider = (smtpPort = ports.submissions) =>
    imapProvider(
      {
        account: 'test',
        imap: { host: 'localhost', port: ports.imaps, secure: true },
        smtp: { host: 'localhost', port: smtpPort, secure: true },
        auth,
      },
      { ca: readFileSync(caFile, 'utf8') },
    );
  /** Saves a draft, submits it, and says how the submit failed and how often it arrived. */
  async function failedSubmit(fields: { id: string; to?: string; extra?: string }, port?: number) {
    await start('full');
    await empty(alice.email);
    const sending = provider(port);
    const raw = message({
      id: fields.id,
      subject: fields.id,
      from: alice.email,
      to: fields.to ?? alice.email,
    });
    const draft = await sending.saveDraft(bytes(fields.extra ? `${fields.extra}\r\n${raw}` : raw));
    const failure = await sending.submit(draft, `<${fields.id}@example.com>`).then(
      () => undefined,
      (error: unknown) => error,
    );
    await sending.close();
    return {
      failure,
      delivered: await count(alice.email, 'INBOX'),
      drafts: await count(alice.email, 'Drafts'),
    };
  }

  test('a submit the host refuses fails for good, and delivers nothing', async () => {
    const { failure, delivered, drafts } = await failedSubmit({
      id: 'refused',
      to: 'someone@example.com',
    });
    expect(failure).toBeInstanceOf(SendFailure);
    expect(failure).toMatchObject({ passing: false });
    expect((failure as SendFailure).message).toMatch(/^localhost refused it: 550 /);
    expect({ delivered, drafts }).toEqual({ delivered: 0, drafts: 1 });
  }, 30_000);

  test('a submit that cannot reach the host fails for now, and delivers nothing', async () => {
    const { failure, delivered } = await failedSubmit({ id: 'unreachable' }, ports.lmtp + 1);
    expect(failure).toBeInstanceOf(SendFailure);
    expect(failure).toMatchObject({ passing: true });
    expect((failure as SendFailure).message).toMatch(/^Couldn’t reach localhost: /);
    expect(delivered).toBe(0);
  }, 30_000);

  // A host that accepts the connection and then says nothing, during TLS or after its greeting.
  for (const [quiet, smtp] of [
    ['during TLS', { secure: true, greets: false }],
    ['after its greeting', { secure: false, greets: true }],
  ] as const) {
    test(`a submit to a host that goes quiet ${quiet} fails for now, after a while`, async () => {
      await start('full');
      await empty(alice.email);
      const host = Bun.listen({
        hostname: 'localhost',
        port: 0,
        socket: {
          open: (socket) => void (smtp.greets && socket.write('220 Busy ESMTP\r\n')),
          data() {},
        },
      });
      const sending = imapProvider(
        {
          account: 'test',
          imap: { host: 'localhost', port: ports.imaps, secure: true },
          smtp: { host: 'localhost', port: host.port, secure: smtp.secure },
          auth,
        },
        { ca: readFileSync(caFile, 'utf8'), patience: 1000 },
      );
      try {
        const raw = message({ id: 'quiet', subject: 'quiet', from: alice.email, to: alice.email });
        const draft = await sending.saveDraft(bytes(raw));
        const started = Date.now();
        const failure = await sending.submit(draft, '<quiet@example.com>').catch((e: unknown) => e);
        expect(Date.now() - started).toBeLessThan(5000);
        expect(failure).toBeInstanceOf(SendFailure);
        expect(failure).toMatchObject({ passing: true });
        expect((failure as SendFailure).message).toMatch(/^Couldn’t reach localhost: /);
      } finally {
        await sending.close();
        host.stop(true);
      }
    }, 30_000);
  }

  test('a submit whose connection drops after the message went out says it may have gone', async () => {
    const { failure, delivered } = await failedSubmit({
      id: 'dropped',
      extra: DROP_AFTER_DATA_HEADER,
    });
    expect(failure).toBeInstanceOf(SendFailure);
    expect(failure).toMatchObject({ passing: false });
    expect((failure as SendFailure).message).toContain('so it may have been delivered');
    expect(delivered).toBe(1);
  }, 30_000);

  test('watches again after the server drops it, and reports what it may have missed', async () => {
    await start('full');
    await empty(alice.email);
    const provider = imapProvider(
      {
        account: 'test',
        imap: { host: 'localhost', port: ports.imaps, secure: true },
        smtp: { host: 'localhost', port: ports.submissions, secure: true },
        auth,
      },
      { ca: readFileSync(caFile, 'utf8') },
    );
    let changes = 0;
    const stop = provider.watch('INBOX', () => changes++);
    await Bun.sleep(1000);
    await kick(alice.email);
    for (const deadline = Date.now() + 10_000; changes === 0 && Date.now() < deadline;) {
      await Bun.sleep(100);
    }
    stop();
    await provider.close();
    expect(changes).toBeGreaterThan(0);
  }, 30_000);
});
