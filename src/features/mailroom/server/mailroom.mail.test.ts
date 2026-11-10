// The Mailroom on the local Workers runtime, against the test mail server: accounts, sync, the
// envelope index, hints, the body cache, and what each member can reach.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ImapFlow } from 'imapflow';
import nodemailer from 'nodemailer';
import type {
  Account,
  ConversationSummary,
  Folder,
  Hint,
  Message,
  MessageRef,
  View,
} from '../../mail/core/index.ts';
import type { AccountSetup, Page } from '../client/index.ts';
import { caFile, empty, ports, start, stop, users } from '../../../../tests/mail-server/server.ts';
import { startWorker, type LocalWorker } from '../../../../tests/workerd.ts';
import { WAKE } from './sync.ts';
import type { Wake } from './test-worker.ts';

const { alice, bob } = users;
const AT = '2026-11-09T12:00:00.000Z';
const setup: AccountSetup = {
  provider: 'imap',
  name: 'Alice',
  address: alice.email,
  imap: { host: 'localhost', port: ports.imaps, secure: true },
  smtp: { host: 'localhost', port: ports.submissions, secure: true },
  password: alice.password,
};

let ca: string;

/** The test worker, with its own storage, and with `vars` added to its environment. */
function mailrooms(vars: Record<string, string> = {}) {
  return startWorker(
    {
      name: 'trail-mix-mailroom-test',
      main: join(import.meta.dir, 'test-worker.ts'),
      durable_objects: { bindings: [{ name: 'MAILROOM', class_name: 'TestMailroom' }] },
      migrations: [{ tag: 'v1', new_sqlite_classes: ['TestMailroom'] }],
      r2_buckets: [{ binding: 'BODIES', bucket_name: 'bodies' }],
      vars: { CREDENTIALS_KEY: 'a-test-key-that-is-at-least-32-characters', ...vars },
    },
    { env: { NODE_EXTRA_CA_CERTS: caFile } },
  );
}

describe('The Mailroom', () => {
  let worker: LocalWorker;
  let account: Account;
  const ada = member('ada', () => worker);
  const bea = member('bea', () => worker);

  beforeAll(async () => {
    await start('full');
    ca = readFileSync(caFile, 'utf8');
    await empty(alice.email);
    await seed();
    worker = await mailrooms();
  }, 120_000);

  afterAll(async () => {
    worker?.stop();
    await stop();
  });

  test('connects an account only once its host takes the password, and keeps it only sealed', async () => {
    await expect(
      ada.call('addAccount', { ...setup, password: 'not-the-password' }),
    ).rejects.toThrow();
    expect(await ada.call('accounts')).toEqual([]);

    account = await ada.call<Account>('addAccount', setup);
    expect(account).toMatchObject({ name: 'Alice', address: alice.email, stamp: 'vermilion' });
    await ada.until(async () => (await ada.call<Account[]>('accounts'))[0]?.status === 'ready');

    const stored = await ada.call<{ tables: Record<string, unknown[]> }>('stored');
    expect(stored.tables.credentials).toHaveLength(1);
    expect(JSON.stringify(stored.tables)).not.toContain(alice.password);
    expect(JSON.stringify(await ada.call('accounts'))).not.toContain(alice.password);
  }, 60_000);

  test('fills the index from the server, with folders by role and conversations newest first', async () => {
    const folders = await ada.call<Folder[]>('folders');
    expect(folders.find((folder) => folder.role === 'inbox')).toMatchObject({
      path: 'INBOX',
      total: 3,
      unread: 3,
    });
    const inbox = await ada.page({ in: 'inbox' });
    expect(inbox.map((row) => row.subject)).toEqual(['Re: Lunch', 'Tickets', 'Garden']);
    // The reply in Inbox and the question in Sent are one conversation.
    expect(inbox[0]).toMatchObject({ count: 2, unread: 1 });
    const thread = await ada.call<Message[]>('conversation', inbox[0]!.id);
    expect(thread.map((message) => message.path)).toEqual(['Sent', 'INBOX']);
  });

  test('tells every open device about new mail within five seconds', async () => {
    const devices = [ada.device(), ada.device()];
    const elsewhere = bea.device();
    // Opening a device checks the account at once, and the Inbox is watched from then on.
    const checked = devices.map((device) => device.next((hint) => hint.changed === 'folders'));
    await Promise.all([...devices, elsewhere].map((device) => device.opened));
    await Promise.all(checked);
    await Bun.sleep(1000);

    const sent = Date.now();
    await submit({ subject: 'Arriving now' });
    await Promise.all(
      devices.map((device) =>
        device.next((hint) => hint.changed === 'conversations' && hint.folder.path === 'INBOX'),
      ),
    );
    await ada.until(async () =>
      (await ada.page({ in: 'inbox' })).some((row) => row.subject === 'Arriving now'),
    );
    // The Inbox's counts are the server's, and change with it.
    await ada.until(async () => {
      const folders = await ada.call<Folder[]>('folders');
      return folders.find((folder) => folder.role === 'inbox')?.unread === 4;
    });
    expect(Date.now() - sent).toBeLessThan(5000);
    expect(elsewhere.hints).toEqual([]);
    for (const device of [...devices, elsewhere]) device.close();
  }, 30_000);

  test('moves to a role, and its undo by the pairs it returned restores the lists', async () => {
    const before = await ada.page({ in: 'inbox' });
    const garden = before.find((row) => row.subject === 'Garden')!;
    const [message] = await ada.call<Message[]>('conversation', garden.id);
    const moved = await ada.call<{ from: MessageRef; to: MessageRef }[]>(
      'move',
      [message],
      'archive',
    );
    expect(moved.map(({ from }) => from)).toEqual([refOf(message!)]);
    expect(moved[0]!.to.path).toBe('Archive');
    await ada.until(
      async () => !(await ada.page({ in: 'inbox' })).some((row) => row.id === garden.id),
    );

    for (const { from, to } of moved) {
      await ada.call('move', [to], { account: from.account, path: from.path });
    }
    await ada.until(async () => Bun.deepEquals(await ada.page({ in: 'inbox' }), before));
  }, 30_000);

  test('another member reaches none of it', async () => {
    const [row] = await ada.page({ in: 'inbox' });
    const [message] = await ada.call<Message[]>('conversation', row!.id);
    expect(await bea.call('accounts')).toEqual([]);
    expect(await bea.call('folders')).toEqual([]);
    expect(await bea.page({ in: 'inbox' })).toEqual([]);
    expect(await bea.call('conversation', row!.id)).toEqual([]);
    await expect(bea.call('body', message)).rejects.toThrow();
    expect(await bea.call('removeAccount', account.id)).toBeNull();
    expect(await ada.call('accounts')).toHaveLength(1);
  });

  test('rebuilds the same lists after its index and body cache are erased', async () => {
    const before = await ada.snapshot();
    const [message] = await ada.call<Message[]>('conversation', before.inbox[0]!.id);
    const body = await ada.call('body', message);
    expect((await ada.call<{ bodies: string[] }>('stored')).bodies).toHaveLength(1);

    await ada.call('eraseIndex');
    expect(await ada.page({ in: 'inbox' })).toEqual([]);
    expect((await ada.call<{ bodies: string[] }>('stored')).bodies).toEqual([]);

    const device = ada.device();
    await device.opened;
    await ada.until(async () => Bun.deepEquals(await ada.snapshot(), before));
    expect(await ada.call('body', message)).toEqual(body);
    device.close();
  }, 60_000);

  test('removing an account erases its index, cached bodies and credentials', async () => {
    const [row] = await ada.page({ in: 'inbox' });
    await ada.call('body', (await ada.call<Message[]>('conversation', row!.id))[0]);
    await ada.call('removeAccount', account.id);
    const { tables, bodies } = await ada.call<{ tables: Record<string, unknown[]>; bodies: [] }>(
      'stored',
    );
    expect(bodies).toEqual([]);
    expect(
      Object.entries(tables).filter(([name, rows]) => name !== 'schema' && rows.length),
    ).toEqual([]);
  });
});

describe('The Mailroom with the demo mailbox', () => {
  let worker: LocalWorker;
  beforeAll(async () => {
    worker = await mailrooms({ DEMO_MAILBOX: '10000', DEMO_MAILBOX_AT: AT });
  }, 120_000);
  afterAll(() => worker?.stop());

  test('starts with Personal and Work, and fills each Inbox first and newest first', async () => {
    const cy = member('cy', () => worker);
    const device = cy.device();
    const inbox = (hint: Hint) => hint.changed === 'conversations' && hint.folder.path === 'INBOX';
    const first = device.next(inbox);
    const started = Date.now();
    await device.opened;
    await first;
    const { folder } = device.hints.find(inbox) as Extract<Hint, { changed: 'conversations' }>;
    const early = await cy.call<Page>('conversations', { in: 'folder', folder });
    const accounts = await cy.call<Account[]>('accounts');
    expect(accounts.map(({ name, stamp }) => [name, stamp])).toEqual([
      ['Personal', 'vermilion'],
      ['Work', 'teal'],
    ]);
    expect(accounts.find(({ id }) => id === folder.account)?.status).toBe('syncing');

    await cy.until(
      async () => (await cy.call<Account[]>('accounts')).every(({ status }) => status === 'ready'),
      120_000,
    );
    console.log(`The demo mailbox synced in ${Date.now() - started} ms.`);
    // The Inbox's newest conversations were there from its first batch. Their rows change as
    // Sent and Archive fill in, but not which ones they are or their order in the Inbox.
    const final = await cy.call<Page>('conversations', { in: 'folder', folder });
    expect(early.items.map(({ id }) => id)).toEqual(final.items.map(({ id }) => id));
    // The newest mail is dated just before the fixed creation time, whenever this runs.
    const newest = Date.parse(final.items[0]!.date);
    expect(newest).toBeLessThan(Date.parse(AT));
    expect(newest).toBeGreaterThan(Date.parse(AT) - 86_400_000);

    // It filled over several wakes, none landing more than its share, and each account read ready
    // only once all of its mail was in.
    const wakes = await cy.call<Wake[]>('wakeLog');
    console.log(
      `It took ${wakes.length} wakes: ${wakes.map(({ steps }) => steps).join(', ')} steps.`,
    );
    expect(wakes.length).toBeGreaterThan(2);
    for (const { steps } of wakes) expect(steps).toBeLessThanOrEqual(WAKE.steps);
    const last = wakes.at(-1)!.accounts;
    expect(wakes[0]!.accounts.map(({ status }) => status)).toEqual(['syncing', 'syncing']);
    for (const { accounts } of wakes) {
      for (const [i, { status, messages }] of accounts.entries()) {
        if (status === 'ready') expect(messages).toBe(last[i]!.messages);
      }
    }
    expect(last.map(({ status }) => status)).toEqual(['ready', 'ready']);
    device.close();
  }, 180_000);
});

/** A member's Mailroom, reached as the test worker names it. */
function member(name: string, worker: () => LocalWorker) {
  const call = async <T = unknown>(method: string, ...args: unknown[]): Promise<T> => {
    const response = await fetch(`${worker().url}/${name}/call`, {
      method: 'POST',
      body: JSON.stringify({ name: method, args }),
    });
    const result = await response.json<{ value?: T; error?: string }>();
    if (result.error !== undefined) throw new Error(result.error);
    return result.value as T;
  };

  /** Every row of a view, following its pages. */
  async function page(view: View): Promise<ConversationSummary[]> {
    const rows: ConversationSummary[] = [];
    for (let after: string | undefined; ;) {
      const next: Page = await call<Page>('conversations', view, after);
      rows.push(...next.items);
      if (!next.next) return rows;
      after = next.next;
    }
  }

  return {
    call,
    page,

    /** What a browser would show: folders, the unified Inbox, and each folder's conversations. */
    async snapshot() {
      const folders = await call<Folder[]>('folders');
      const inbox = await page({ in: 'inbox' });
      const lists = await Promise.all(
        folders.map((folder) =>
          page({ in: 'folder', folder: { account: folder.account, path: folder.path } }),
        ),
      );
      const threads = await Promise.all(
        inbox.map((row) => call<Message[]>('conversation', row.id)),
      );
      return { folders, inbox, lists, threads };
    },

    async until(done: () => Promise<boolean>, ms = 30_000) {
      const deadline = Date.now() + ms;
      while (!(await done())) {
        if (Date.now() > deadline) throw new Error('Timed out');
        await Bun.sleep(100);
      }
    },

    /** An open browser: its hint socket, and every hint it has heard. */
    device() {
      const socket = new WebSocket(`${worker().url.replace('http', 'ws')}/${name}/updates`);
      const hints: Hint[] = [];
      const waiting = new Set<() => void>();
      socket.addEventListener('message', (event) => {
        hints.push(JSON.parse(String(event.data)) as Hint);
        for (const wake of waiting) wake();
      });
      return {
        hints,
        opened: new Promise((resolve, reject) => {
          socket.addEventListener('open', resolve);
          socket.addEventListener('error', reject);
        }),
        /** Resolves when a hint from now on matches. */
        next(matches: (hint: Hint) => boolean, ms = 10_000) {
          const from = hints.length;
          return new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('No such hint arrived')), ms);
            const wake = () => {
              if (!hints.slice(from).some(matches)) return;
              clearTimeout(timer);
              waiting.delete(wake);
              resolve();
            };
            waiting.add(wake);
          });
        },
        close: () => socket.close(),
      };
    },
  };
}

/** Alice's mailbox: two letters, and a question in Sent with its reply in Inbox. */
async function seed() {
  const client = new ImapFlow({
    host: 'localhost',
    port: ports.imaps,
    secure: true,
    auth: { user: alice.email, pass: alice.password },
    tls: { ca: [ca] },
    logger: false,
  });
  await client.connect();
  await client.append('INBOX', raw({ id: 'garden', subject: 'Garden', minutesAgo: 90 }));
  await client.append('INBOX', raw({ id: 'tickets', subject: 'Tickets', minutesAgo: 60 }));
  await client.append(
    'Sent',
    raw({ id: 'lunch', subject: 'Lunch', minutesAgo: 30, from: alice.email, to: bob.email }),
    ['\\Seen'],
  );
  await client.append(
    'INBOX',
    raw({ id: 'lunch-reply', subject: 'Re: Lunch', minutesAgo: 10, inReplyTo: 'lunch' }),
  );
  await client.logout();
}

/** Mail from Bob, through the submission server, as it arrives from anyone. */
async function submit({ subject }: { subject: string }) {
  const transport = nodemailer.createTransport({
    host: 'localhost',
    port: ports.submissions,
    secure: true,
    auth: { user: bob.email, pass: bob.password },
    tls: { ca: [ca] },
  });
  await transport.sendMail({ from: bob.email, to: alice.email, subject, text: `${subject}.` });
  transport.close();
}

function raw(fields: {
  id: string;
  subject: string;
  minutesAgo: number;
  from?: string;
  to?: string;
  inReplyTo?: string;
}) {
  return [
    `From: ${fields.from ?? bob.email}`,
    `To: ${fields.to ?? alice.email}`,
    `Subject: ${fields.subject}`,
    `Date: ${new Date(Date.now() - fields.minutesAgo * 60_000).toUTCString()}`,
    `Message-ID: <${fields.id}@trailmix.test>`,
    ...(fields.inReplyTo ? [`In-Reply-To: <${fields.inReplyTo}@trailmix.test>`] : []),
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    '',
    `This is ${fields.subject}.`,
    '',
  ].join('\r\n');
}

const refOf = ({ account, path, uidValidity, uid }: Message) => ({
  account,
  path,
  uidValidity,
  uid,
});
