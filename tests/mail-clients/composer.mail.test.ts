// Mail written in Trail Mix's composer, read in two other mail clients from the test mail server.
// The built app runs on workerd against Dovecot, with Alice's account added as a browser adds one.
// Roundcube shows a reply's formatting, its pasted image inline and its file, and mutt shows its
// plain text, the Markdown the composer saved, with no HTML. Each threads the reply with the
// message it answers: Roundcube as Dovecot threads it, and mutt by itself from the headers alone.
// A draft is in Roundcube's Drafts within ten seconds of the first keystroke, a tab closed
// mid-sentence keeps all it had written up to the last save, and the draft opens again in Trail
// Mix with its formatting and its file.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ImapFlow } from 'imapflow';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import PostalMime from 'postal-mime';
import { SAVE_AT_LEAST_EVERY_MS } from '../../src/features/composer/core/session.ts';
import { serverFunctionIds, startPreview, type Preview } from '../e2e/preview.ts';
import { caFile, empty, ports, start, stop, users } from '../mail-server/server.ts';
import { missing } from './clients.ts';
import { mutt } from './mutt.ts';
import { roundcube, type Roundcube } from './roundcube.ts';

const { alice, bob } = users;
type User = { email: string; password: string };

/** A 4 by 3 pixel PNG, pasted into the reply from the clipboard. */
const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAQAAAADCAIAAAA7ljmRAAAAGElEQVR4nGOQ91/86aA3hGSAs4AkA7IMAGQcEltTdKHYAAAAAElFTkSuQmCC';
const NOTES = 'Bring a jacket, the terrace gets cold.\n';

describe.skipIf(missing('mutt', 'php') !== undefined)('Mail written in Trail Mix', () => {
  let ca: string;
  let app: Preview;
  let webmail: Roundcube;
  let browser: Browser;

  beforeAll(async () => {
    await start('full');
    ca = readFileSync(caFile, 'utf8');
    await Promise.all([empty(alice.email), empty(bob.email)]);
    // Bob asked Alice and kept a copy, so his question is in both Inboxes. Dan's message shares its
    // subject and nothing else, so only a client that threads by subject would join the two.
    const question = raw({
      id: 'lunch',
      from: `Bob <${bob.email}>`,
      to: alice.email,
      cc: bob.email,
      subject: 'Lunch on Thursday?',
      text: 'Shall we try the new place?',
    });
    for (const user of [alice, bob])
      await withImap(user, (client) => client.append('INBOX', question));
    await withImap(bob, (client) =>
      client.append(
        'INBOX',
        raw({
          id: 'other-lunch',
          from: 'Dan <dan@example.com>',
          to: bob.email,
          subject: 'Re: Lunch on Thursday?',
          text: 'A different lunch altogether.',
        }),
      ),
    );

    // The app as production serves it, without the demo mailbox, so it takes a real account.
    [app, webmail, browser] = await Promise.all([
      startPreview(
        { DEMO_MAILBOX: '', DEV_MEMBER: `mail-clients-${Date.now()}@trailmix.test` },
        { NODE_EXTRA_CA_CERTS: caFile },
      ),
      roundcube(ports.webmail),
      chromium.launch(),
    ]);
    const page = await trailMix();
    await addAlice(page);
    await page.close();
  }, 120_000);

  afterAll(async () => {
    await browser?.close();
    await webmail?.stop();
    await app?.stop();
    await stop();
  });

  describe('a reply, sent', () => {
    let written: string;
    let messageId: string;

    beforeAll(async () => {
      const page = await trailMix();
      await page.getByRole('option').filter({ hasText: 'Lunch on Thursday?' }).click();
      await page
        .getByRole('region', { name: 'Reader' })
        .getByRole('button', { name: 'Reply', exact: true })
        .click();
      const reply = page.getByRole('region', { name: 'Reply' });
      const text = reply.getByRole('textbox', { name: 'Reply' });
      await text.waitFor();
      // Markdown as a member types it, which the editor formats as it goes.
      await page.keyboard.type('Thursday works for me, **noon at Café Rosa**.');
      await page.keyboard.press('Enter');
      await page.keyboard.type("- I'll bring the plans");
      await page.keyboard.press('Enter');
      await page.keyboard.type('You bring the menu: https://example.com/menu ');
      await page.keyboard.press('Enter');
      await page.keyboard.press('Enter');
      // The image goes through the system clipboard and a real paste.
      await page.evaluate(async (png) => {
        const bytes = Uint8Array.from(atob(png), (char) => char.charCodeAt(0));
        const image = new Blob([bytes], { type: 'image/png' });
        const { navigator, ClipboardItem } = globalThis as unknown as Clipboard;
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': image })]);
      }, PNG);
      await page.keyboard.press('ControlOrMeta+V');
      await text.locator('img').waitFor();
      await reply.locator('input[type="file"]:not([accept])').setInputFiles({
        name: 'notes.txt',
        mimeType: 'text/plain',
        buffer: Buffer.from(NOTES),
      });
      await reply.getByText('notes.txt').waitFor();
      await text.focus();
      await page.keyboard.press('ControlOrMeta+Enter');
      await page
        .getByRole('region', { name: 'Notifications' })
        .getByText(/^Sending to Bob in \d+s/)
        .waitFor();

      // Once the undo window closes, the Mailroom sends it.
      const sent = await until(() => replyIn(bob), 60_000);
      messageId = sent.messageId;
      written = sent.text;
      await page.close();
    }, 120_000);

    test('its text part is the Markdown the composer saved', () => {
      expect(written).toContain('Thursday works for me, **noon at Café Rosa**.');
      expect(written).toContain("- I'll bring the plans");
      expect(written).toContain('[https://example.com/menu](https://example.com/menu)');
      expect(written).toMatch(/!\[[^\]]*\]\(cid:[^)]+\)/);
      expect(written).not.toMatch(/<\/?[a-z]+[\s>]/i);
    });

    test('shows in Roundcube with its formatting, its pasted image inline and its file, in its thread', async () => {
      const page = await signedIn(bob);
      const parent = await uidOf(bob, '<lunch@example.com>');
      const answer = await uidOf(bob, messageId);

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
        'You bring the menu: https://example.com/menu',
      ]);
      await expect(
        body.locator('a', { hasText: 'example.com' }).getAttribute('href'),
      ).resolves.toBe('https://example.com/menu');
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
      const download = await page.request.get(
        new URL(`${link}&_download=1`, `${webmail.url}/`).href,
      );
      expect(await download.text()).toBe(NOTES);
      await page.context().close();
    }, 60_000);

    test('shows in mutt in its thread, its plain text exactly as the composer saved it, with its file intact', async () => {
      const id = messageId.replace(/^<|>$/g, '');
      const dir = await mutt(
        bob,
        [
          // Every message mutt threads with Bob's question. Dan's Message-ID ends the same way.
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
      expect(shown).toContain(written);
      expect(shown).not.toMatch(/<\/?(p|strong|ul|li|a|img|html|body)\b/i);
      expect(readFileSync(join(dir, 'notes.txt'), 'utf8')).toBe(NOTES);
    }, 60_000);
  });

  test('a draft is in Roundcube’s Drafts within ten seconds, keeps what a closed tab wrote, and opens again intact', async () => {
    const subject = `Plans for Friday ${Date.now()}`;
    const page = await trailMix();
    const drafts = await signedIn(alice);
    await page.keyboard.press('c');
    const composer = page.getByRole('region', { name: 'New message' });
    await composer.waitFor();

    // From the first keystroke, Roundcube's Drafts is read again until the draft is in it.
    const firstKey = performance.now();
    await page.keyboard.type(bob.email);
    const listed = until(async () => {
      // Roundcube draws the page, then asks for its list, so the rows count once the list arrives.
      const listing = drafts.waitForResponse((response) => response.url().includes('_action=list'));
      await drafts.goto(`${webmail.url}/?_task=mail&_mbox=Drafts`);
      await listing;
      const rows = await drafts.locator('#messagelist tr.message').count();
      return rows > 0 ? performance.now() : undefined;
    }, 20_000);
    await composer.getByRole('textbox', { name: 'Subject' }).fill(subject);
    const message = composer.getByRole('textbox', { name: 'Message' });
    await message.click();
    await page.keyboard.type('**Agenda** for Friday: ');
    await composer.locator('input[type="file"]:not([accept])').setInputFiles({
      name: 'agenda.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('1. Lunch\n2. The engine\n'),
    });
    await composer.getByText('agenda.txt').waitFor();
    await message.focus();
    await page.keyboard.press('End');

    // Words go in steadily, with no pause long enough to save after, until the tab closes.
    const typed: { word: string; at: number }[] = [];
    const typingUntil = performance.now() + SAVE_AT_LEAST_EVERY_MS * 2.5;
    for (let at = 0; performance.now() < typingUntil; at++) {
      const word = `w${at}`;
      await page.keyboard.type(`${word} `);
      typed.push({ word, at: performance.now() });
      await page.waitForTimeout(100);
    }
    const shownAfter = (await listed) - firstKey;
    console.log(
      `The draft was in Roundcube's Drafts ${Math.round(shownAfter)} ms after the first keystroke.`,
    );
    expect(shownAfter).toBeLessThan(10_000);

    // At worst, the network goes with the tab, so the save the page makes as it hides never lands.
    const closedAt = performance.now();
    await page.context().setOffline(true);
    await page.context().close();

    // Roundcube shows every word typed before the last save the tab could have started.
    const uid = await until(async () => {
      const found = await withImap(alice, async (client) => {
        const lock = await client.getMailboxLock('Drafts');
        try {
          const uids = await client.search({ subject }, { uid: true });
          return Array.isArray(uids) && uids.length === 1 ? uids[0] : undefined;
        } finally {
          lock.release();
        }
      });
      return found;
    }, 10_000);
    await drafts.goto(`${webmail.url}/?_task=mail&_mbox=Drafts&_uid=${uid}&_action=show`);
    const kept = new Set((await drafts.locator('#messagebody').textContent())?.split(/\s+/));
    const mustKeep = typed.filter(({ at }) => at < closedAt - SAVE_AT_LEAST_EVERY_MS - 1_000);
    expect(mustKeep.length).toBeGreaterThan(10);
    expect(mustKeep.filter(({ word }) => !kept.has(word))).toEqual([]);
    await drafts.context().close();

    // Trail Mix opens it again with its bold and its file.
    const again = await trailMix();
    await again
      .getByRole('button', { name: /^Drafts/ })
      .first()
      .click();
    await again.getByRole('option').filter({ hasText: subject }).click();
    await again
      .getByRole('region', { name: 'Reader' })
      .getByRole('button', { name: /^Draft/ })
      .click();
    const reopened = again.getByRole('region', { name: 'New message' });
    const words = reopened.getByRole('textbox', { name: 'Message' });
    await expect(words.locator('strong').textContent()).resolves.toBe('Agenda');
    await expect(
      reopened.getByRole('list', { name: 'Attachments' }).textContent(),
    ).resolves.toMatch(/^agenda\.txt/);
    await again.context().close();
  }, 120_000);

  /** Trail Mix in a desktop browser that may use the clipboard, once the Mailroom is up to date. */
  async function trailMix(): Promise<Page> {
    const context: BrowserContext = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      permissions: ['clipboard-read', 'clipboard-write'],
    });
    const page = await context.newPage();
    await page.goto(app.url);
    return page;
  }

  /** Adds Alice's account as the browser does: a command to the Mailroom, from Trail Mix's page. */
  async function addAlice(page: Page) {
    const added = await page.evaluate(
      async ({ url, setup }) => {
        const call = new FormData();
        call.set('call', JSON.stringify({ name: 'addAccount', args: [setup] }));
        const response = await fetch(url, {
          method: 'POST',
          body: call,
          headers: { 'x-tsr-serverFn': 'true' },
        });
        return response.status;
      },
      {
        url: `/_serverFn/${serverFunctionIds().command}`,
        setup: {
          provider: 'imap',
          name: 'Alice',
          address: alice.email,
          fromName: 'Alice Liddell',
          imap: { host: 'localhost', port: ports.imaps, secure: true },
          smtp: { host: 'localhost', port: ports.submissions, secure: true },
          password: alice.password,
        },
      },
    );
    expect(added).toBe(200);
    await page.getByText('Up to date').waitFor({ state: 'attached', timeout: 30_000 });
    await page.getByRole('option').filter({ hasText: 'Lunch on Thursday?' }).waitFor();
  }

  /** A Roundcube page, signed in as `user`, on their Inbox. */
  async function signedIn(user: User): Promise<Page> {
    const page = await (await browser.newContext()).newPage();
    await page.goto(webmail.url);
    await page.fill('#rcmloginuser', user.email);
    await page.fill('#rcmloginpwd', user.password);
    await page.click('#rcmloginsubmit');
    await page.waitForSelector('#messagelist');
    return page;
  }

  /** Alice's reply in `user`'s Inbox, once it is there: its Message-ID and its text part. */
  async function replyIn(user: User) {
    return withImap(user, async (client) => {
      const lock = await client.getMailboxLock('INBOX');
      try {
        const found = await client.search({ from: alice.email }, { uid: true });
        if (!Array.isArray(found) || found.length === 0) return undefined;
        const message = await client.fetchOne(
          String(found.at(-1)),
          { source: true },
          { uid: true },
        );
        if (!message || !message.source) return undefined;
        const parsed = await PostalMime.parse(message.source);
        return { messageId: parsed.messageId ?? '', text: parsed.text ?? '' };
      } finally {
        lock.release();
      }
    });
  }

  /** The UID of the message with this Message-ID in `user`'s Inbox. */
  async function uidOf(user: User, messageId: string) {
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

  async function withImap<T>(user: User, use: (client: ImapFlow) => Promise<T>): Promise<T> {
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

/** Resolves with what `find` finds, asking again until it finds something or time runs out. */
async function until<T>(find: () => Promise<T | undefined>, ms: number): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const found = await find();
    if (found !== undefined) return found;
    if (Date.now() > deadline) throw new Error(`Nothing turned up in ${ms} ms.`);
    await Bun.sleep(250);
  }
}

/** What a Roundcube page holds of its message list, threaded. */
type RoundcubePage = {
  rcmail: {
    message_list: {
      rowcount: number;
      rows: Record<string, { uid: string; parent_uid?: string; depth: number }>;
    };
  };
};

/** The page's system clipboard, as far as these tests write to it. */
type Clipboard = {
  navigator: { clipboard: { write(items: unknown[]): Promise<void> } };
  ClipboardItem: new (items: Record<string, Blob>) => unknown;
};

/** An image in the page, as far as these tests read it. */
type Picture = { decode(): Promise<void>; naturalWidth: number; naturalHeight: number };

function raw(fields: {
  id: string;
  from: string;
  to: string;
  cc?: string;
  subject: string;
  text: string;
}) {
  return [
    `Message-ID: <${fields.id}@example.com>`,
    `Date: ${new Date(Date.now() - 60 * 60_000).toUTCString()}`,
    `From: ${fields.from}`,
    `To: ${fields.to}`,
    ...(fields.cc ? [`Cc: ${fields.cc}`] : []),
    `Subject: ${fields.subject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    '',
    fields.text,
    '',
  ].join('\r\n');
}
