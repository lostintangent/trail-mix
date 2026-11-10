// The Mailroom on the local Workers runtime, against the test mail server: accounts, sync, the
// envelope index, hints, the body cache, and what each member can reach.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ImapFlow } from 'imapflow';
import nodemailer from 'nodemailer';
import type {
  Account,
  Body,
  ConversationSummary,
  Folder,
  Hint,
  Message,
  MessageRef,
  Outgoing,
  View,
} from '../../mail/core/index.ts';
import { RESTARTED, UNDO_SECONDS } from '../../outbox/core/index.ts';
import PostalMime from 'postal-mime';
import { sendable, type AccountSetup, type Page } from '../client/contract.ts';
import {
  caFile,
  empty,
  pauseSending,
  ports,
  settled,
  start,
  stop,
  users,
  type Profile,
} from '../../../../tests/mail-server/server.ts';
import { startWorker, type LocalWorker } from '../../../../tests/workerd.ts';
import { WAKE } from './sync.ts';
import type { Wake } from './test-worker.ts';

const { alice, bob } = users;
const AT = '2026-11-09T12:00:00.000Z';
const setup: AccountSetup = {
  provider: 'imap',
  name: 'Alice',
  address: alice.email,
  fromName: 'Alice Liddell',
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

  test('tells every open device about new mail within five seconds, and nothing else', async () => {
    const wakes = (await ada.call<Wake[]>('wakeLog')).length;
    const devices = [ada.device(), ada.device()];
    const elsewhere = bea.device();
    // Opening a device checks the account at once, and the Inbox is watched from then on. Nothing
    // changed, so the check hints nothing.
    await Promise.all([...devices, elsewhere].map((device) => device.opened));
    await ada.until(async () => (await ada.call<Wake[]>('wakeLog')).length > wakes);
    await Bun.sleep(1000);
    expect(devices.map((device) => device.hints)).toEqual([[], []]);

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

  test('searches the index as each word is typed', async () => {
    expect((await ada.page({ in: 'search', text: 're lun' })).map((row) => row.subject)).toEqual([
      'Re: Lunch',
    ]);
    expect(await ada.page({ in: 'search', text: 'periwinkle' })).toEqual([]);
  });

  test('finds what only an older message holds on the server, opens it, and leaves the index be', async () => {
    const before = (await ada.call<{ tables: Record<string, unknown[]> }>('stored')).tables;
    const rows = await ada.page({ in: 'search', text: 'periwinkle', fullText: true });
    expect(rows.map((row) => row.subject)).toEqual(['Old letter']);
    const [message] = await ada.call<Message[]>('conversation', rows[0]!.id);
    expect(message).toMatchObject({ subject: 'Old letter', path: 'Archive' });
    expect((await ada.call<{ text: string }>('body', message)).text).toContain('periwinkle');
    expect((await ada.call<{ tables: Record<string, unknown[]> }>('stored')).tables).toEqual(
      before,
    );

    // A restart forgets what the search found, and the conversation reads as one gone elsewhere.
    await ada.call('restart').catch(() => {});
    expect(await ada.call('conversation', rows[0]!.id)).toEqual([]);
  }, 30_000);

  /** The message with this subject, as the index holds it. */
  const held = async (subject: string) => {
    const row = (await ada.page({ in: 'search', text: subject })).find(
      (found) => found.subject === subject,
    );
    const messages = await ada.call<Message[]>('conversation', row!.id);
    return refOf(messages.find((message) => message.subject === subject)!);
  };

  describe('triage, as the browser sends it, on the server', () => {
    type Moved = { from: MessageRef; to: MessageRef };
    /** Undoes moves as the browser does, each back to its folder. Returns where each landed. */
    const undo = async (moved: Moved[]) =>
      (
        await Promise.all(
          moved.map(({ from, to }) =>
            ada.call<Moved[]>('move', [to], { account: from.account, path: from.path }),
          ),
        )
      ).flat();

    test('archives and deletes as moves to a role, and each undo moves it back', async () => {
      let tickets = await held('Tickets');
      for (const role of ['archive', 'trash'] as const) {
        const moved = await ada.call<{ from: MessageRef; to: MessageRef }[]>(
          'move',
          [tickets],
          role,
        );
        const path = role === 'archive' ? 'Archive' : 'Trash';
        expect(moved.map(({ to }) => to.path)).toEqual([path]);
        expect(await onServer(path)).toContainKey('<tickets@trailmix.test>');
        expect(await onServer('INBOX')).not.toContainKey('<tickets@trailmix.test>');
        // Back in the Inbox under a new UID, which the undo says.
        tickets = (await undo(moved))[0]!.to;
        expect(tickets.path).toBe('INBOX');
        expect(await onServer('INBOX')).toContainKey('<tickets@trailmix.test>');
        expect(await onServer(path)).not.toContainKey('<tickets@trailmix.test>');
      }
    }, 30_000);

    test('moves to a folder of the account, and deletes a search hit from Archive', async () => {
      await ada.call('createFolder', { account: account.id, path: 'Receipts' });
      const garden = await held('Garden');
      const moved = await ada.call<{ from: MessageRef; to: MessageRef }[]>('move', [garden], {
        account: account.id,
        path: 'Receipts',
      });
      expect(await onServer('Receipts')).toContainKey('<garden@trailmix.test>');
      await undo(moved);
      expect(await onServer('INBOX')).toContainKey('<garden@trailmix.test>');

      // Found only by the server's own search, outside the index.
      const [row] = await ada.page({ in: 'search', text: 'periwinkle', fullText: true });
      const [old] = await ada.call<Message[]>('conversation', row!.id);
      const deleted = await ada.call<{ from: MessageRef; to: MessageRef }[]>(
        'move',
        [refOf(old!)],
        'trash',
      );
      expect(await onServer('Trash')).toContainKey('<old@trailmix.test>');
      await undo(deleted);
      expect(await onServer('Archive')).toContainKey('<old@trailmix.test>');
    }, 30_000);

    test('flags and marks read on the server, and the opposite change undoes it', async () => {
      const lunch = await held('Re: Lunch');
      const flagged = async () => {
        const flags = (await onServer('INBOX'))['<lunch-reply@trailmix.test>'] ?? [];
        return ['\\Flagged', '\\Seen'].filter((flag) => flags.includes(flag));
      };
      await ada.call('setFlags', [lunch], { flagged: true, seen: true });
      expect(await flagged()).toEqual(['\\Flagged', '\\Seen']);
      await ada.call('setFlags', [lunch], { flagged: false, seen: false });
      expect(await flagged()).toEqual([]);
    });

    test('creates, renames and deletes folders on the server', async () => {
      const folder = { account: account.id, path: 'Receipts' };
      await ada.call('renameFolder', folder, 'Receipts 2026');
      expect(await foldersOnServer()).toContain('Receipts 2026');
      await ada.call('deleteFolder', { ...folder, path: 'Receipts 2026' });
      expect(await foldersOnServer()).not.toContain('Receipts 2026');
      await ada.until(async () =>
        (await ada.call<Folder[]>('folders')).every(({ path }) => !path.startsWith('Receipts')),
      );
    }, 30_000);

    test('a move the server refuses rejects with what the server said', async () => {
      const garden = await held('Garden');
      // Another client deleted this folder a moment ago, as far as the browser knows.
      const refused = ada.call('move', [garden], { account: account.id, path: 'Gone' });
      await expect(refused).rejects.toThrow(/doesn't exist/i);
      expect(await onServer('INBOX')).toContainKey('<garden@trailmix.test>');
    });
  });

  describe('drafts, as the composer saves them, on the server', () => {
    const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    const draft = (change: Record<string, unknown>) => ({
      account: account.id,
      to: [{ name: 'Bob', email: bob.email }],
      cc: [],
      bcc: [],
      subject: 'Plans',
      markdown: 'Thursday works.\n',
      attachments: [],
      ...change,
    });
    const notes = () => new File(['Bring a jacket.'], 'notes.txt', { type: 'text/plain' });

    test('writes the Markdown, a pasted image and a file as one message in Drafts, joined to its reply', async () => {
      const lunch = await held('Re: Lunch');
      const markdown =
        'Thursday works,  \n**café** at noon 🙂\n\n![chart](cid:chart@trailmix.invalid)\n';
      const saved = await ada.call<MessageRef>(
        'saveDraft',
        draft({
          subject: 'Re: Lunch',
          markdown,
          inReplyTo: lunch,
          attachments: [
            {
              file: new File([png], 'chart.png', { type: 'image/png' }),
              contentId: 'chart@trailmix.invalid',
            },
            { file: notes() },
          ],
        }),
      );
      expect(saved).toMatchObject({ account: account.id, path: 'Drafts' });

      const { flags, source } = await draftOnServer(saved);
      expect(flags).toContain('\\Draft');
      const written = await PostalMime.parse(source);
      expect(written).toMatchObject({
        from: { name: 'Alice Liddell', address: alice.email },
        to: [{ name: 'Bob', address: bob.email }],
        subject: 'Re: Lunch',
        inReplyTo: '<lunch-reply@trailmix.test>',
        references: '<lunch@trailmix.test> <lunch-reply@trailmix.test>',
      });
      expect(written.messageId).toMatch(/^<[\w-]+@trailmix\.test>$/);
      expect(written.html).toContain('src="cid:chart@trailmix.invalid"');
      // Its plain text is the Markdown exactly as typed, which is how the composer reopens it.
      expect(written.text).toBe(markdown);
      expect(written.html).toContain('<strong>café</strong>');
      expect(
        written.attachments.map((part) => ({
          name: part.filename,
          type: part.mimeType,
          disposition: part.disposition,
          contentId: part.contentId,
          content: [...new Uint8Array(part.content as ArrayBuffer)],
        })),
      ).toEqual([
        {
          name: 'chart.png',
          type: 'image/png',
          disposition: 'inline',
          contentId: '<chart@trailmix.invalid>',
          content: [...png],
        },
        {
          name: 'notes.txt',
          type: 'text/plain',
          disposition: 'attachment',
          contentId: undefined,
          content: [...new TextEncoder().encode('Bring a jacket.')],
        },
      ]);

      // Once sync reads Drafts, the reply waits under its conversation.
      const [thread] = (await ada.page({ in: 'inbox' })).filter(
        (row) => row.subject === 'Re: Lunch',
      );
      await ada.until(async () =>
        (await ada.call<Message[]>('conversation', thread!.id)).some(
          (message) => refOf(message).uid === saved.uid && message.path === 'Drafts',
        ),
      );
      await ada.call('move', [saved], 'trash');
    }, 30_000);

    test('each save replaces the last and carries its attachments over without their bytes', async () => {
      const first = await ada.call<MessageRef>(
        'saveDraft',
        draft({ attachments: [{ file: notes() }] }),
      );
      // Saved a moment ago and not yet in the index, it answers what it holds all the same.
      const [held] = (await ada.call<Body>('body', first)).attachments;
      expect(held).toMatchObject({ name: 'notes.txt' });

      const second = await ada.call<MessageRef>(
        'saveDraft',
        draft({
          markdown: 'Thursday works, see the notes.\n',
          attachments: [{ in: first, id: held!.id }],
        }),
        first,
      );
      await expect(draftOnServer(first)).rejects.toThrow(/isn’t in Drafts/);
      const written = await PostalMime.parse((await draftOnServer(second)).source);
      expect(written.text).toContain('see the notes.');
      expect(
        written.attachments.map((part) => [
          part.filename,
          new TextDecoder().decode(part.content as ArrayBuffer),
        ]),
      ).toEqual([['notes.txt', 'Bring a jacket.']]);
      // The replaced draft's bytes leave the body cache with it.
      const { bodies } = await ada.call<{ bodies: string[] }>('stored');
      expect(bodies.filter((key) => key.includes('/Drafts/'))).toEqual([]);

      await ada.until(async () => {
        const rows = await ada.page({ in: 'drafts' });
        return rows.length === 1 && rows[0]!.subject === 'Plans';
      });
      const [row] = await ada.page({ in: 'drafts' });
      const [message] = await ada.call<Message[]>('conversation', row!.id);
      expect(refOf(message!)).toEqual(second);
      await ada.call('move', [second], 'trash');
    }, 30_000);

    test('writes From with the name the account was last given, or the address alone', async () => {
      const from = async () => {
        const saved = await ada.call<MessageRef>('saveDraft', draft({}));
        const written = await PostalMime.parse((await draftOnServer(saved)).source);
        await ada.call('move', [saved], 'trash');
        return written.from;
      };
      await ada.call('updateAccount', account.id, { fromName: 'Liddell, Alice' });
      expect(await from()).toEqual({ name: 'Liddell, Alice', address: alice.email });
      await ada.call('updateAccount', account.id, { name: 'Alice at home' });
      expect(await from()).toEqual({ name: 'Liddell, Alice', address: alice.email });

      await ada.call('updateAccount', account.id, { fromName: '' });
      expect(await from()).toEqual({ name: '', address: alice.email });
      expect((await ada.call<Account[]>('accounts'))[0]).not.toContainKey('fromName');
      await ada.call('updateAccount', account.id, { name: 'Alice', fromName: 'Alice Liddell' });
    }, 30_000);

    test('a draft replaces only a draft of its own account', async () => {
      const lunch = await held('Re: Lunch');
      await expect(
        ada.call('saveDraft', draft({}), { ...lunch, account: 'elsewhere' }),
      ).rejects.toThrow(/only a draft of the account/);
      const saved = await ada.call<MessageRef>('saveDraft', draft({}), lunch);
      expect(await onServer('INBOX')).toContainKey('<lunch-reply@trailmix.test>');
      await ada.call('move', [saved], 'trash');
    }, 30_000);
  });

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
    expect((await ada.call<{ bodies: string[] }>('stored')).bodies.length).toBeGreaterThan(0);

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
    // Only the schema's version and the search table's own bookkeeping remain, with no word of mail.
    expect(
      Object.entries(tables).filter(
        ([name, rows]) => name !== 'schema' && !name.startsWith('search_') && rows.length,
      ),
    ).toEqual([]);
    expect(JSON.stringify(tables).toLowerCase()).not.toMatch(/garden|tickets|lunch|alice|bob/);
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

    // Search reads every account at once: Sam is on mail in both.
    const found = await cy.call<Page>('conversations', { in: 'search', text: 'sam rivera' });
    expect(new Set(found.items.map(({ account }) => account))).toEqual(
      new Set(accounts.map(({ id }) => id)),
    );
    device.close();
  }, 180_000);

  test('saves a draft with its files in a demo account, where the composer finds it', async () => {
    const cy = member('cy', () => worker);
    const [, work] = await cy.call<Account[]>('accounts');
    const saved = await cy.call<MessageRef>('saveDraft', {
      account: work!.id,
      to: [{ email: 'sam@example.com' }],
      cc: [],
      bcc: [],
      subject: 'Quarterly numbers',
      markdown: 'Attached.\n',
      attachments: [{ file: new File(['1,2,3'], 'numbers.csv', { type: 'text/csv' }) }],
    });
    await cy.until(async () =>
      (await cy.page({ in: 'drafts' })).some((row) => row.subject === 'Quarterly numbers'),
    );
    const body = await cy.call<Body>('body', saved);
    expect(body.attachments).toMatchObject([{ name: 'numbers.csv', type: 'text/csv', size: 5 }]);
    expect(body.headers.find(([name]) => name === 'From')?.[1]).toBe(
      'Sam Rivera <sam@work.trailmix.test>',
    );
  }, 30_000);
});

for (const profile of ['full', 'outlook'] as const satisfies Profile[]) {
  const filesSent = profile === 'outlook';
  const host = filesSent ? 'a host that files its own copy in Sent' : 'a host Trail Mix files for';

  describe(`The Outbox, on ${host}`, () => {
    let worker: LocalWorker;
    let account: Account;
    // No device of this member's ever opens, so only the alarm sends.
    const cal = member('cal', () => worker);

    beforeAll(async () => {
      await start(profile);
      ca = readFileSync(caFile, 'utf8');
      await Promise.all([empty(alice.email), empty(bob.email)]);
      worker = await mailrooms();
      account = await cal.call<Account>('addAccount', setup);
      await cal.until(async () => (await cal.call<Account[]>('accounts'))[0]?.status === 'ready');
      if (filesSent) await cal.call('hostFilesSent', account.id).catch(() => {});
    }, 120_000);

    afterAll(async () => {
      worker?.stop();
      await stop();
    });

    /** A draft from Alice to Bob, as the composer saves it. */
    const draftOf = (subject: string) => ({
      account: account.id,
      to: [{ name: 'Bob', email: bob.email }],
      cc: [],
      bcc: [],
      subject,
      markdown: `About ${subject}.\n`,
      attachments: [],
    });
    const drafted = (subject: string) => cal.call<MessageRef>('saveDraft', draftOf(subject));
    const outbox = () => cal.call<Outgoing[]>('outbox');
    /** How many times a subject is in Bob's Inbox, Alice's Sent and Alice's Drafts. */
    async function whereIs(subject: string) {
      await settled();
      const count = async (user: { email: string; password: string }, path: string) =>
        (await subjectsIn(user, path)).filter((held) => held === subject).length;
      return {
        delivered: await count(bob, 'INBOX'),
        sent: await count(alice, 'Sent'),
        drafts: await count(alice, 'Drafts'),
      };
    }

    test('an undo inside the window delivers nothing and leaves the draft as it was', async () => {
      const saved = await drafted('Undone');
      const before = (await draftOnServer(saved)).source;
      const pressed = Date.now();
      const sending = await cal.call<Outgoing>('send', saved);
      expect(sending).toMatchObject({
        draft: saved,
        to: [{ name: 'Bob', email: bob.email }],
        subject: 'Undone',
        state: 'waiting',
        attempts: 0,
      });
      expect(Date.parse(sending.sendAt) - pressed).toBeGreaterThanOrEqual(UNDO_SECONDS * 1000 - 50);
      // A row opens the conversation its draft is in, once the index holds the draft.
      await cal.until(async () => (await outbox())[0]?.conversation !== undefined);
      const [row] = await outbox();
      expect(row).toEqual({ ...sending, conversation: row!.conversation });
      const thread = await cal.call<Message[]>('conversation', row!.conversation);
      expect(thread.map(({ subject }) => subject)).toEqual(['Undone']);
      await expect(cal.call('conversations', { in: 'outbox' })).rejects.toThrow(
        'The Outbox is listed by outbox().',
      );

      expect(await cal.call<MessageRef>('cancelSend', sending.id)).toEqual(saved);
      expect(await outbox()).toEqual([]);
      await Bun.sleep(UNDO_SECONDS * 1000 + 2000);
      expect(await whereIs('Undone')).toEqual({ delivered: 0, sent: 0, drafts: 1 });
      expect((await draftOnServer(saved)).source).toEqual(before);
    }, 60_000);

    test('a draft on its way can’t be replaced until its send is undone', async () => {
      const saved = await drafted('Steady');
      const { id } = await cal.call<Outgoing>('send', saved);
      await expect(cal.call('saveDraft', draftOf('Steady'), saved)).rejects.toThrow(
        'That draft is on its way. Undo the send to change it.',
      );
      await cal.call('cancelSend', id);
      await cal.call('saveDraft', draftOf('Steady, changed'), saved);
      expect(await whereIs('Steady')).toMatchObject({ delivered: 0, drafts: 0 });
    }, 60_000);

    test('a send scheduled ahead goes at its time, with no device open', async () => {
      const saved = await drafted('Scheduled');
      const at = new Date(Date.now() + 20_000).toISOString();
      const sending = await cal.call<Outgoing>('send', saved, at);
      expect(sending.sendAt).toBe(at);
      // Saving another draft wakes the Mailroom to sync it, and that wake keeps the send's time.
      await drafted('Meanwhile');
      await cal.until(async () => (await outbox()).length === 0, 60_000);
      expect(Date.now()).toBeGreaterThanOrEqual(Date.parse(at));
      expect(await whereIs('Scheduled')).toEqual({ delivered: 1, sent: 1, drafts: 0 });
    }, 90_000);

    test('a send the server refuses stays failed with its reason, and goes on Retry', async () => {
      pauseSending(alice.email, true);
      const saved = await drafted('Refused');
      const { id } = await cal.call<Outgoing>('send', saved);
      await cal.until(async () => (await outbox())[0]?.state === 'failed', 60_000);
      const [failed] = await outbox();
      expect(failed).toMatchObject({ id, state: 'failed', attempts: 1 });
      expect(failed!.error).toMatch(/^localhost refused it: 554 5\.7\.1 Sending is paused/);
      expect(await whereIs('Refused')).toEqual({ delivered: 0, sent: 0, drafts: 1 });

      pauseSending(alice.email, false);
      expect(await cal.call<Outgoing>('retrySend', id)).toMatchObject({ state: 'waiting' });
      await cal.until(async () => (await outbox()).length === 0, 60_000);
      expect(await whereIs('Refused')).toEqual({ delivered: 1, sent: 1, drafts: 0 });
    }, 90_000);

    test('changing a draft whose send failed takes that send out of the Outbox', async () => {
      pauseSending(alice.email, true);
      const saved = await drafted('Fixed');
      try {
        await cal.call<Outgoing>('send', saved);
        await cal.until(async () => (await outbox())[0]?.state === 'failed', 60_000);
      } finally {
        pauseSending(alice.email, false);
      }
      const fixed = await cal.call<MessageRef>('saveDraft', draftOf('Fixed, again'), saved);
      expect(await outbox()).toEqual([]);
      const sending = await cal.call<Outgoing>('send', fixed);
      expect(await outbox()).toEqual([sending]);
      await cal.call('cancelSend', sending.id);
    }, 90_000);

    test('a restart before the Outbox records acceptance holds the send, saying it may have gone', async () => {
      const saved = await drafted('Interrupted');
      await cal.call('restartWhenAccepted');
      const { id } = await cal.call<Outgoing>('send', saved);
      await cal.until(async () => (await outbox())[0]?.state === 'failed', 60_000);
      expect((await outbox())[0]).toMatchObject({ id, state: 'failed', error: RESTARTED });
      // The host had the message, and the draft waits as it was.
      expect(await whereIs('Interrupted')).toEqual({
        delivered: 1,
        sent: filesSent ? 1 : 0,
        drafts: 1,
      });
      if (!filesSent) return;
      // Retry finds the copy the host filed in Sent, and delivers nothing again.
      await cal.call('retrySend', id);
      await cal.until(async () => (await outbox()).length === 0, 60_000);
      expect(await whereIs('Interrupted')).toEqual({ delivered: 1, sent: 1, drafts: 0 });
    }, 90_000);
  });
}

/** A member's Mailroom, reached as the test worker names it. */
function member(name: string, worker: () => LocalWorker) {
  const call = async <T = unknown>(method: string, ...args: unknown[]): Promise<T> => {
    // As a browser sends it: a call carrying files goes as form data.
    const sent = sendable({ name: method, args });
    const response = await fetch(`${worker().url}/${name}/call`, {
      method: 'POST',
      body: sent instanceof FormData ? sent : JSON.stringify(sent),
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

/** Each message in one of Alice's folders on the server, by Message-ID, with its flags. */
async function onServer(path: string): Promise<Record<string, string[]>> {
  return asAlice(async (client) => {
    const lock = await client.getMailboxLock(path);
    try {
      const found: Record<string, string[]> = {};
      if (!client.mailbox || client.mailbox.exists === 0) return found;
      for await (const message of client.fetch('1:*', { envelope: true, flags: true })) {
        found[message.envelope?.messageId ?? ''] = [...(message.flags ?? [])];
      }
      return found;
    } finally {
      lock.release();
    }
  });
}

/** A message of Alice's on the server, as its raw source and its flags. */
async function draftOnServer(ref: MessageRef): Promise<{ source: Uint8Array; flags: string[] }> {
  return asAlice(async (client) => {
    const lock = await client.getMailboxLock(ref.path);
    try {
      const found = await client.fetchOne(
        String(ref.uid),
        { source: true, flags: true },
        { uid: true },
      );
      if (!found || !found.source) throw new Error(`UID ${ref.uid} isn’t in ${ref.path}.`);
      return { source: new Uint8Array(found.source), flags: [...(found.flags ?? [])] };
    } finally {
      lock.release();
    }
  });
}

/** The subjects in a folder of a user's, one for each message, as the server holds them. */
async function subjectsIn(user: { email: string; password: string }, path: string) {
  const client = new ImapFlow({
    host: 'localhost',
    port: ports.imaps,
    secure: true,
    auth: { user: user.email, pass: user.password },
    tls: { ca: [ca] },
    logger: false,
  });
  await client.connect();
  try {
    const lock = await client.getMailboxLock(path);
    try {
      if (!client.mailbox || client.mailbox.exists === 0) return [];
      const subjects: string[] = [];
      for await (const message of client.fetch('1:*', { envelope: true })) {
        subjects.push(message.envelope?.subject ?? '');
      }
      return subjects;
    } finally {
      lock.release();
    }
  } finally {
    await client.logout();
  }
}

/** Alice's folders, as the server lists them. */
const foldersOnServer = () =>
  asAlice(async (client) => (await client.list()).map((folder) => folder.path));

async function asAlice<T>(use: (client: ImapFlow) => Promise<T>): Promise<T> {
  const client = new ImapFlow({
    host: 'localhost',
    port: ports.imaps,
    secure: true,
    auth: { user: alice.email, pass: alice.password },
    tls: { ca: [ca] },
    logger: false,
  });
  await client.connect();
  try {
    return await use(client);
  } finally {
    await client.logout();
  }
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
  // Older than the index keeps, so only the server's own search finds it.
  const twoYears = 2 * 365 * 24 * 60;
  await client.append(
    'Archive',
    raw({ id: 'old', subject: 'Old letter', minutesAgo: twoYears, text: 'A periwinkle teapot.' }),
    ['\\Seen'],
    new Date(Date.now() - twoYears * 60_000),
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
  text?: string;
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
    fields.text ?? `This is ${fields.subject}.`,
    '',
  ].join('\r\n');
}

const refOf = ({ account, path, uidValidity, uid }: Message) => ({
  account,
  path,
  uidValidity,
  uid,
});
