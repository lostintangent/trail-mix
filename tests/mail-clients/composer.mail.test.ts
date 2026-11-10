// A reply written in Trail Mix, read in two other mail clients from the test mail server. Roundcube
// shows its formatting, its pasted image inline and its file. mutt shows its plain text exactly as
// written. Each puts it in the thread it answers: Roundcube as Dovecot threads it, and mutt by
// itself, from the headers alone. The reply goes through the Mailroom's commands carrying what the
// composer sends.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ImapFlow } from 'imapflow';
import { chromium, type Browser, type Page } from 'playwright';
import type { Account, Message, MessageRef, Outgoing } from '../../src/features/mail/core/index.ts';
import type { AccountSetup } from '../../src/features/mailroom/client/contract.ts';
import { caFile, empty, ports, start, stop, users } from '../mail-server/server.ts';
import { mailrooms, member } from '../mailrooms.ts';
import type { LocalWorker } from '../workerd.ts';
import { missing } from './clients.ts';
import { mutt } from './mutt.ts';
import { roundcube, type Roundcube } from './roundcube.ts';

const { alice, bob } = users;
const setup: AccountSetup = {
  provider: 'imap',
  name: 'Alice',
  address: alice.email,
  fromName: 'Alice Liddell',
  imap: { host: 'localhost', port: ports.imaps, secure: true },
  smtp: { host: 'localhost', port: ports.submissions, secure: true },
  password: alice.password,
};

const MARKDOWN = `Thursday works for me, **noon at Café Rosa**.

- I'll bring the plans
- You bring the [menu](https://example.com/menu)

![chart](cid:chart@trailmix.invalid)
`;
/** A 4 by 3 pixel PNG, pasted into the reply. */
const PNG = Uint8Array.fromBase64(
  'iVBORw0KGgoAAAANSUhEUgAAAAQAAAADCAIAAAA7ljmRAAAAGElEQVR4nGOQ91/86aA3hGSAs4AkA7IMAGQcEltTdKHYAAAAAElFTkSuQmCC',
);
const NOTES = 'Bring a jacket, the terrace gets cold.\n';

describe.skipIf(missing('mutt', 'php') !== undefined)('A reply written in Trail Mix', () => {
  let ca: string;
  let worker: LocalWorker;
  let webmail: Roundcube;
  let browser: Browser;
  let account: Account;
  let reply: Outgoing;
  const dee = member('dee', () => worker);

  beforeAll(async () => {
    await start('full');
    ca = readFileSync(caFile, 'utf8');
    await Promise.all([empty(alice.email), empty(bob.email)]);
    // Carol asked them both, so the question is in both Inboxes. Dan's message shares its subject
    // and nothing else, so only a client that threads by subject would put it in the thread.
    const question = raw({
      id: 'lunch',
      from: 'Carol <carol@example.com>',
      to: `${alice.email}, ${bob.email}`,
      subject: 'Lunch on Thursday?',
      text: 'Shall we try the new place?',
    });
    for (const user of [alice, bob]) await append(user, 'INBOX', question);
    await append(
      bob,
      'INBOX',
      raw({
        id: 'other-lunch',
        from: 'Dan <dan@example.com>',
        to: bob.email,
        subject: 'Re: Lunch on Thursday?',
        text: 'A different lunch altogether.',
      }),
    );

    [worker, webmail, browser] = await Promise.all([
      mailrooms(),
      roundcube(ports.webmail),
      chromium.launch(),
    ]);
    account = await dee.call<Account>('addAccount', setup);
    await dee.until(async () => (await dee.call<Account[]>('accounts'))[0]?.status === 'ready');

    const [row] = await dee.page({ in: 'inbox' });
    const [asked] = await dee.call<Message[]>('conversation', row!.id);
    const draft = await dee.call<MessageRef>('saveDraft', {
      account: account.id,
      to: [{ name: 'Bob', email: bob.email }],
      cc: [],
      bcc: [],
      subject: 'Re: Lunch on Thursday?',
      markdown: MARKDOWN,
      inReplyTo: refOf(asked!),
      attachments: [
        {
          file: new File([PNG], 'chart.png', { type: 'image/png' }),
          contentId: 'chart@trailmix.invalid',
        },
        { file: new File([NOTES], 'notes.txt', { type: 'text/plain' }) },
      ],
    });
    reply = await dee.call<Outgoing>('send', draft);
    await dee.until(async () => (await dee.call<Outgoing[]>('outbox')).length === 0, 60_000);
  }, 120_000);

  afterAll(async () => {
    await browser?.close();
    await webmail?.stop();
    worker?.stop();
    await stop();
  });

  test('shows in Roundcube with its formatting, its pasted image inline and its file, in its thread', async () => {
    const page = await signedIn(bob);
    const parent = await uidOf(bob, '<lunch@example.com>');
    const answer = await uidOf(bob, reply.messageId);

    // Roundcube's own model of the list, threaded by Dovecot.
    await page.waitForFunction(
      () => (globalThis as unknown as RoundcubePage).rcmail.message_list.rowcount >= 3,
    );
    const rows = await page.evaluate(() =>
      Object.values((globalThis as unknown as RoundcubePage).rcmail.message_list.rows).map(
        ({ uid, parent_uid, depth }) => ({
          uid: Number(uid),
          parent: Number(parent_uid ?? 0),
          depth,
        }),
      ),
    );
    expect(rows.find(({ uid }) => uid === answer)).toMatchObject({ parent, depth: 1 });

    await page.goto(`${webmail.url}/?_task=mail&_mbox=INBOX&_uid=${answer}&_action=show`);
    const body = page.locator('#messagebody');
    await expect(body.locator('strong').textContent()).resolves.toBe('noon at Café Rosa');
    expect(await body.locator('li').allTextContents()).toEqual([
      "I'll bring the plans",
      'You bring the menu',
    ]);
    await expect(body.locator('a', { hasText: 'menu' }).getAttribute('href')).resolves.toBe(
      'https://example.com/menu',
    );
    const image = body.locator('img');
    await image.evaluate((img) => (img as unknown as Picture).decode());
    expect(
      await image.evaluate((img) => [
        (img as unknown as Picture).naturalWidth,
        (img as unknown as Picture).naturalHeight,
      ]),
    ).toEqual([4, 3]);

    // The pasted image shows in the message, so only the file is listed to download.
    const files = page.locator('#attachment-list li');
    const listed = await files.allTextContents();
    expect(listed).toHaveLength(1);
    expect(listed[0]).toContain('notes.txt');
    const link = await files.locator('a').first().getAttribute('href');
    const download = await page.request.get(new URL(`${link}&_download=1`, `${webmail.url}/`).href);
    expect(await download.text()).toBe(NOTES);
    await page.close();
  }, 60_000);

  test('shows in mutt in its thread, its plain text exactly as written, with its file intact', async () => {
    const id = reply.messageId.replace(/^<|>$/g, '');
    const dir = await mutt(
      bob,
      [
        // Every message mutt threads with Carol's question. Dan's Message-ID ends the same way.
        '<search>~i ^.lunch@example<enter><tag-thread>',
        '<tag-prefix><pipe-message>cat >> thread.txt<enter><untag-pattern>~A<enter>',
        // The reply as mutt shows it, and its file as mutt saves it.
        `<search>~i ${id}<enter><pipe-message>cat > reply.txt<enter>`,
        '<view-attachments><search>notes.txt<enter><save-entry><kill-line>notes.txt<enter><exit>',
        '<quit>',
      ].join(''),
    );
    const thread = readFileSync(join(dir, 'thread.txt'), 'utf8');
    expect(thread.match(/^Subject: .*$/gm)).toEqual([
      'Subject: Lunch on Thursday?',
      'Subject: Re: Lunch on Thursday?',
    ]);
    expect(thread).not.toContain('A different lunch');

    const shown = readFileSync(join(dir, 'reply.txt'), 'utf8');
    expect(shown).toContain(MARKDOWN);
    expect(shown).not.toMatch(/<\/?(p|strong|ul|li|a|img|html|body)\b/i);
    expect(readFileSync(join(dir, 'notes.txt'), 'utf8')).toBe(NOTES);
  }, 60_000);

  test('saved as a draft, it shows in Drafts in Roundcube', async () => {
    await dee.call<MessageRef>('saveDraft', {
      account: account.id,
      to: [{ email: bob.email }],
      cc: [],
      bcc: [],
      subject: 'Plans for Friday',
      markdown: 'Still thinking.\n',
      attachments: [],
    });
    const page = await signedIn(alice);
    await page.goto(`${webmail.url}/?_task=mail&_mbox=Drafts`);
    await expect(
      page.locator('#messagelist').getByText('Plans for Friday').waitFor(),
    ).resolves.toBeUndefined();
    await page.close();
  }, 60_000);

  /** A Roundcube page, signed in as `user`, on their Inbox. */
  async function signedIn(user: { email: string; password: string }): Promise<Page> {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(webmail.url);
    await page.fill('#rcmloginuser', user.email);
    await page.fill('#rcmloginpwd', user.password);
    await page.click('#rcmloginsubmit');
    await page.waitForSelector('#messagelist');
    return page;
  }

  /** The UID of the message with this Message-ID in `user`'s Inbox. */
  async function uidOf(user: { email: string; password: string }, messageId: string) {
    return withImap(user, async (client) => {
      const lock = await client.getMailboxLock('INBOX');
      try {
        const found = await client.search({ header: { 'message-id': messageId } }, { uid: true });
        if (!Array.isArray(found) || found.length !== 1) {
          throw new Error(`${user.email}'s Inbox has no one message ${messageId}.`);
        }
        return found[0]!;
      } finally {
        lock.release();
      }
    });
  }

  function append(user: { email: string; password: string }, path: string, message: string) {
    return withImap(user, (client) => client.append(path, message));
  }

  async function withImap<T>(
    user: { email: string; password: string },
    use: (client: ImapFlow) => Promise<T>,
  ): Promise<T> {
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
      return await use(client);
    } finally {
      await client.logout();
    }
  }
});

/** What a Roundcube page holds of its message list, threaded. */
type RoundcubePage = {
  rcmail: {
    message_list: {
      rowcount: number;
      rows: Record<string, { uid: string; parent_uid?: string; depth: number }>;
    };
  };
};

/** An image in the page, as far as these tests read it. */
type Picture = { decode(): Promise<void>; naturalWidth: number; naturalHeight: number };

function raw(fields: { id: string; from: string; to: string; subject: string; text: string }) {
  return [
    `Message-ID: <${fields.id}@example.com>`,
    `Date: ${new Date(Date.now() - 60 * 60_000).toUTCString()}`,
    `From: ${fields.from}`,
    `To: ${fields.to}`,
    `Subject: ${fields.subject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    '',
    fields.text,
    '',
  ].join('\r\n');
}

const refOf = ({ account, path, uidValidity, uid }: Message): MessageRef => ({
  account,
  path,
  uidValidity,
  uid,
});
