// Mail written in Trail Mix's composer, read in two other mail clients from the test mail server.
// The built app runs on workerd against Dovecot, with Alice's account added as a browser adds one.
// Roundcube shows a reply's formatting, its pasted image inline and its file, and mutt shows its
// plain text, the Markdown the composer saved, with no HTML. Each threads the reply with the
// message it answers: Roundcube as Dovecot threads it, and mutt by itself from the headers alone.
// A draft is in Roundcube's Drafts within ten seconds of the first keystroke, a tab closed
// mid-sentence keeps all it had written up to the last save, and the draft opens again in Trail
// Mix with its formatting and its file. A draft another client wrote, quoting mail with remote
// images, can be opened, written in, saved, copied from and closed, and its conversation read,
// without the page or the Mailroom loading any of them.
import { afterAll, beforeAll, describe, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ImapFlow } from 'imapflow';
import type { Page } from 'playwright';
import PostalMime from 'postal-mime';
import { SAVE_AT_LEAST_EVERY_MS } from '../../src/features/composer/core/session.ts';
import { serverFunctionIds } from '../e2e/preview.ts';
import { suite } from '../e2e/suite.ts';
import { caFile, empty, ports, start, stop, users } from '../mail-server/server.ts';
import { missing } from './clients.ts';
import { mutt } from './mutt.ts';
import { roundcube, type Roundcube } from './roundcube.ts';
import { mailIsIn } from '../mailIsIn.ts';

const { alice, bob } = users;
type User = { email: string; password: string };

/** A 4 by 3 pixel PNG, pasted into the reply from the clipboard. */
const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAQAAAADCAIAAAA7ljmRAAAAGElEQVR4nGOQ91/86aA3hGSAs4AkA7IMAGQcEltTdKHYAAAAAElFTkSuQmCC';
const NOTES = 'Bring a jacket, the terrace gets cold.\n';

describe.skipIf(missing('mutt', 'php') !== undefined)('Mail written in Trail Mix', () => {
  let ca: string;
  let webmail: Roundcube;

  // The test mail server starts first, since it makes the certificate authority the app trusts.
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
  }, 120_000);

  // The app as production serves it, without the demo mailbox, so it takes a real account.
  const app = suite({
    vars: { DEMO_MAILBOX: '', DEV_MEMBER: `mail-clients-${Date.now()}@trailmix.test` },
    env: { NODE_EXTRA_CA_CERTS: caFile },
  });
  // A test that fails leaves a screenshot of each page and what it showed, for CI to keep.
  const { test } = app;

  beforeAll(
    app.witnessed('Alice’s account, added', async () => {
      webmail = await roundcube(ports.webmail);
      const page = await trailMix();
      await addAlice(page);
      await page.close();
    }),
    120_000,
  );

  afterAll(async () => {
    await webmail?.stop();
    await stop();
  });

  describe('a reply, sent', () => {
    let written: string;
    let messageId: string;

    beforeAll(app.witnessed('a reply, sent', replyAndSend), 120_000);

    /** Alice answers Bob with formatting, a pasted image and a file, and sends it. */
    async function replyAndSend() {
      const page = await trailMix();
      await page.getByRole('option').filter({ hasText: 'Lunch on Thursday?' }).click();
      await page
        .getByRole('region', { name: 'Reader' })
        .getByRole('button', { name: 'Reply', exact: true })
        // The newest message's own.
        .last()
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
      // Its countdown lies on its line at the end of the conversation.
      await page
        .getByRole('region', { name: 'Reader' })
        .getByText(/^Sending in \d+s$/)
        .waitFor();

      // Once the undo window closes, the Mailroom sends it.
      const sent = await until(() => replyIn(bob), 60_000);
      messageId = sent.messageId;
      written = sent.text;
      await page.close();
    }

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

  test('a draft another client wrote, with an image in its HTML, opens in Trail Mix with the image shown', async () => {
    const subject = `Floor plan ${Date.now()}`;
    await withImap(alice, (client) =>
      client.append('Drafts', htmlDraft(subject), ['\\Draft', '\\Seen']),
    );
    const page = await trailMix();
    await page
      .getByRole('button', { name: /^Drafts/ })
      .first()
      .click();
    await page.getByRole('option').filter({ hasText: subject }).click({ timeout: 30_000 });
    await page
      .getByRole('region', { name: 'Reader' })
      .getByRole('button', { name: /^Draft/ })
      .click();
    const words = page
      .getByRole('region', { name: 'New message' })
      .getByRole('textbox', { name: 'Message' });
    const image = words.locator('img[src^="/messages/"]');
    await image.waitFor();
    expect(
      await image.evaluate(async (img) => {
        await (img as unknown as Picture).decode();
        return [
          (img as unknown as Picture).naturalWidth,
          (img as unknown as Picture).naturalHeight,
        ];
      }),
    ).toEqual([4, 3]);
    await page.context().close();
  }, 60_000);

  test('a draft answering mail Trail Mix never held opens as a reply, keeps what it answers as it saves, and stays a reply when its send is undone', async () => {
    // Written in another client, in answer to mail older than the index keeps.
    const subject = `Re: The old plan ${Date.now()}`;
    const thread = {
      inReplyTo: '<old-plan@example.com>',
      references: '<first-plan@example.com> <old-plan@example.com>',
    };
    await withImap(alice, (client) =>
      client.append(
        'Drafts',
        [
          `Message-ID: <plan-reply-${Date.now()}@example.com>`,
          `Date: ${new Date().toUTCString()}`,
          `From: Alice <${alice.email}>`,
          `To: Bob <${bob.email}>`,
          `Subject: ${subject}`,
          `In-Reply-To: ${thread.inReplyTo}`,
          `References: ${thread.references}`,
          'Content-Type: text/plain; charset=utf-8',
          '',
          'Still on for it?',
          '',
        ].join('\r\n'),
        ['\\Draft', '\\Seen'],
      ),
    );
    const page = await trailMix();
    await page
      .getByRole('button', { name: /^Drafts/ })
      .first()
      .click();
    await page.getByRole('option').filter({ hasText: subject }).click({ timeout: 30_000 });
    await page
      .getByRole('region', { name: 'Reader' })
      .getByRole('button', { name: /^Draft/ })
      .click();
    const reply = page.getByRole('region', { name: 'Reply' });
    // Nothing it answers lies above it, so it fills the reader with its subject.
    await expect(reply.getByRole('textbox', { name: 'Subject' }).inputValue()).resolves.toBe(
      subject,
    );
    await reply.getByRole('textbox', { name: 'Reply' }).getByText('Still on for it?').click();
    await page.keyboard.press('End');
    await page.keyboard.type(' Let me know by Friday.');

    // Saved over the draft it opened, which answers the same mail.
    const saved = await until(
      () =>
        withImap(alice, async (client) => {
          const lock = await client.getMailboxLock('Drafts');
          try {
            const found = await client.search({ subject }, { uid: true });
            if (!Array.isArray(found) || found.length !== 1) return undefined;
            const message = await client.fetchOne(
              String(found[0]),
              { source: true },
              { uid: true },
            );
            const parsed = message && message.source && (await PostalMime.parse(message.source));
            return parsed && parsed.text?.includes('Let me know by Friday.') ? parsed : undefined;
          } finally {
            lock.release();
          }
        }),
      10_000,
    );
    expect({ inReplyTo: saved.inReplyTo, references: saved.references }).toEqual(thread);

    // Sent, then undone, it comes back as the reply it was.
    await page.keyboard.press('ControlOrMeta+Enter');
    await reply.waitFor({ state: 'detached' });
    const notifications = page.getByRole('region', { name: 'Notifications' });
    await notifications.getByText(/^Sending to Bob in \d+s$/).waitFor();
    await notifications.getByRole('button', { name: 'Undo' }).click();
    await expect(
      reply.getByRole('textbox', { name: 'Reply' }).textContent({ timeout: 10_000 }),
    ).resolves.toContain('Let me know by Friday.');
    await page.context().close();
  }, 60_000);

  describe('a draft another client wrote, answering mail with remote images, loads none of them', () => {
    // A web server on this machine that counts every request, standing in for a tracking pixel.
    const asked: string[] = [];
    let pixels: ReturnType<typeof Bun.serve>;
    const pixel = (name: string) => `http://127.0.0.1:${pixels.port}/${name}.png`;

    beforeAll(() => {
      pixels = Bun.serve({
        hostname: '127.0.0.1',
        port: 0,
        fetch(request) {
          asked.push(new URL(request.url).pathname);
          return new Response(Uint8Array.from(Buffer.from(PNG, 'base64')), {
            headers: { 'content-type': 'image/png' },
          });
        },
      });
    });
    afterAll(() => pixels?.stop(true));

    test('quoted in its text, which opens as Markdown', async () => {
      const offer = await fromMallory();
      await draftReplying(offer, {
        text: [
          'Not for me, thanks.',
          '',
          '> Claim your prize:',
          '>',
          `> ![prize](${pixel('quoted-markdown')})`,
          '>',
          `> <img src="${pixel('quoted-html')}" alt="prize">`,
          '>',
          '> Reply by Friday.',
        ].join('\r\n'),
        html: `<p>Not for me, thanks.</p><blockquote><p>Claim your prize:</p><img src="${pixel('draft-html')}" alt="prize"></blockquote>`,
      });
      await writeInAndRead(offer);
    }, 90_000);

    test('in its HTML alone', async () => {
      const offer = await fromMallory();
      await draftReplying(offer, {
        html: [
          '<p>Not for me, thanks.</p>',
          `<blockquote style="background: url(${pixel('background')})">`,
          '<p>Claim your prize:</p>',
          `<img src="${pixel('src')}" srcset="${pixel('srcset')} 2x" alt="prize">`,
          `<picture><source srcset="${pixel('source')}"><img src="${pixel('picture')}"></picture>`,
          `<video poster="${pixel('poster')}"></video>`,
          '<p>Reply by Friday.</p>',
          '</blockquote>',
        ].join(''),
      });
      await writeInAndRead(offer);
    }, 90_000);

    /**
     * Opens the draft in the reader and then in the composer, types and lets it save, copies all of
     * it, closes the composer, and reads its conversation. The pixel server hears nothing.
     */
    async function writeInAndRead(offer: { subject: string }) {
      asked.length = 0;
      const page = await trailMix();
      const reader = page.getByRole('region', { name: 'Reader' });
      await page
        .getByRole('button', { name: /^Drafts/ })
        .first()
        .click();
      await page.getByRole('option').filter({ hasText: offer.subject }).click({ timeout: 30_000 });
      await reader.getByRole('button', { name: /^Draft/ }).click();
      const composer = page.getByRole('region', { name: 'Reply' });
      const words = composer.getByRole('textbox', { name: 'Reply' });
      await words.getByText('Claim your prize:').waitFor();
      // Typed in the quote's last words, so its images stay in the document as it saves and closes.
      await words.getByText('Reply by Friday.').click();
      await page.keyboard.type(' Please stop writing.');
      await page.getByRole('status').filter({ hasText: 'Saved to Drafts' }).waitFor();
      await page.keyboard.press('ControlOrMeta+A');
      await page.keyboard.press('ControlOrMeta+C');
      await composer.getByRole('button', { name: 'Close' }).click();
      await composer.waitFor({ state: 'detached' });

      await page
        .getByRole('button', { name: /^Inbox/ })
        .first()
        .click();
      await page.getByRole('option').filter({ hasText: offer.subject }).click({ timeout: 30_000 });
      await reader.getByText('Images from Mallory are hidden.').waitFor();
      // Long enough for a load the page started to reach the server.
      await page.waitForTimeout(1_000);
      expect(asked).toEqual([]);
      await page.context().close();
    }

    /** A message in Alice's Inbox whose text and HTML both show remote images. */
    async function fromMallory() {
      const id = `offer-${Date.now()}@example.com`;
      const subject = `You have won ${Date.now()}`;
      await withImap(alice, (client) =>
        client.append(
          'INBOX',
          alternative({
            headers: [
              `Message-ID: <${id}>`,
              'From: Mallory <mallory@example.com>',
              `To: ${alice.email}`,
              `Subject: ${subject}`,
            ],
            text: `Claim your prize:\r\n![prize](${pixel('inbox-markdown')})`,
            html: `<p>Claim your prize:</p><img src="${pixel('inbox-html')}" alt="prize">`,
          }),
        ),
      );
      return { id, subject };
    }

    /** Alice's reply to `offer`, as a client that quotes what it answers saves it to Drafts. */
    async function draftReplying(
      offer: { id: string; subject: string },
      body: { text?: string; html: string },
    ) {
      const headers = [
        `Message-ID: <reply-${Date.now()}@example.com>`,
        `From: Alice <${alice.email}>`,
        'To: Mallory <mallory@example.com>',
        `Subject: Re: ${offer.subject}`,
        `In-Reply-To: <${offer.id}>`,
        `References: <${offer.id}>`,
      ];
      const draft =
        body.text === undefined
          ? [
              ...headers,
              `Date: ${new Date().toUTCString()}`,
              'MIME-Version: 1.0',
              'Content-Type: text/html; charset=utf-8',
              '',
              body.html,
              '',
            ].join('\r\n')
          : alternative({ headers, text: body.text, html: body.html });
      await withImap(alice, (client) => client.append('Drafts', draft, ['\\Draft', '\\Seen']));
    }
  });

  /** Trail Mix in a desktop browser that may use the clipboard. */
  async function trailMix(): Promise<Page> {
    const context = await app.context({
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
    await mailIsIn(page);
    await page.getByRole('option').filter({ hasText: 'Lunch on Thursday?' }).waitFor();
  }

  /** A Roundcube page, signed in as `user`, on their Inbox. */
  async function signedIn(user: User): Promise<Page> {
    const page = await (await app.context()).newPage();
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

/** A draft as a client that writes HTML alone saves it, showing a PNG it carries by `cid:`. */
function htmlDraft(subject: string): string {
  return [
    `Message-ID: <plan-${Date.now()}@example.com>`,
    `Date: ${new Date().toUTCString()}`,
    `From: Alice <alice@trailmix.test>`,
    `To: Bob <bob@trailmix.test>`,
    `Subject: ${subject}`,
    'MIME-Version: 1.0',
    'Content-Type: multipart/related; boundary="plan"',
    '',
    '--plan',
    'Content-Type: text/html; charset=utf-8',
    '',
    '<p>Here is the <b>floor plan</b>:</p><p><img src="cid:plan@example.com" alt="plan"></p>',
    '--plan',
    'Content-Type: image/png; name="plan.png"',
    'Content-Disposition: inline; filename="plan.png"',
    'Content-ID: <plan@example.com>',
    'Content-Transfer-Encoding: base64',
    '',
    PNG,
    '--plan--',
    '',
  ].join('\r\n');
}

/** A message with a text and an HTML version of the same words. */
function alternative({ headers, text, html }: { headers: string[]; text: string; html: string }) {
  return [
    ...headers,
    `Date: ${new Date().toUTCString()}`,
    'MIME-Version: 1.0',
    'Content-Type: multipart/alternative; boundary="versions"',
    '',
    '--versions',
    'Content-Type: text/plain; charset=utf-8',
    '',
    text,
    '--versions',
    'Content-Type: text/html; charset=utf-8',
    '',
    html,
    '--versions--',
    '',
  ].join('\r\n');
}

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
