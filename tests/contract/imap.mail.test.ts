// The contract suite against the IMAP provider and the test mail server, once for each profile, so
// the provider meets the contract without QRESYNC and SPECIAL-USE, as on Zoho, and without
// CONDSTORE, as on Outlook.
import { afterAll } from 'bun:test';
import { readFileSync } from 'node:fs';
import { ImapFlow } from 'imapflow';
import nodemailer from 'nodemailer';
import { imapProvider } from '../../src/features/providers/imap/provider.ts';
import {
  caFile,
  empty,
  ports,
  profiles,
  resetUidValidity,
  start,
  stop,
  users,
  type Profile,
} from '../mail-server/server.ts';
import { describeContract, type Harness } from './contract.ts';

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
  describeContract(`The IMAP provider on the ${profile} profile`, () => harness(profile));
}
