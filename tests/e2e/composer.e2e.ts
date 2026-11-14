import { afterEach, beforeAll, expect } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, webkit, type Locator, type Page } from 'playwright';
import { SAVE_AFTER_MS, SAVE_AT_LEAST_EVERY_MS } from '../../src/features/composer/core/session.ts';
import { unreadableText } from './contrast.ts';
import { suite } from './suite.ts';
import { atRest } from '../atRest.ts';
import { mailIsIn } from '../mailIsIn.ts';

/**
 * Writing, end to end: the built app on workerd with a member's demo mail. What the member writes
 * is saved to the account's Drafts as it goes, so a tab closed mid-sentence loses at most the last
 * few seconds, and a draft opened again comes back as it was written.
 *
 * It runs in Chromium at a desktop size, and in WebKit at a phone's, where the composer is a sheet
 * and contenteditable has the most quirks: `E2E_ENGINE=webkit E2E_SIZE=phone`.
 */

const SHOTS = join(import.meta.dir, '../../test-results');
const MEMBER = `composer-${Date.now()}@trailmix.test`;
const IS_PHONE = process.env.E2E_SIZE === 'phone';
const SIZE = IS_PHONE
  ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }
  : { viewport: { width: 1440, height: 900 } };
const ENGINE = process.env.E2E_ENGINE === 'webkit' ? webkit : chromium;

const app = suite({ vars: { DEV_MEMBER: MEMBER }, engine: ENGINE });
// A test that fails leaves a screenshot of each page and what it showed, for CI to keep.
const { test } = app;

beforeAll(() => {
  mkdirSync(SHOTS, { recursive: true });
});

/** Every error a page threw during a test, which fails it. */
const errors: string[] = [];
afterEach(() => {
  expect(errors.splice(0)).toEqual([]);
});

/** A browser on the unified Inbox, once the Mailroom has filled it. */
async function inbox(): Promise<Page> {
  const page = await (await app.context(SIZE)).newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(app.url);
  await mailIsIn(page);
  return page;
}

const reader = (page: Page) => page.getByRole('region', { name: 'Reader' });
const saved = (page: Page) => page.getByRole('status').filter({ hasText: 'Saved to Drafts' });

/** The composer by its name, whether it lies on the page or rises as a phone's sheet. */
const composerNamed = (page: Page, name: 'Reply' | 'New message') =>
  page.locator(`section[aria-label="${name}"]`);

/** The reader's Reply to the newest message: on its own sheet on a desktop, in the island on a phone. */
const replyButton = (page: Page) =>
  reader(page).getByRole('button', { name: 'Reply', exact: true }).filter({ visible: true }).last();

/**
 * Leaves the composer, which keeps what was written in Drafts: by Escape on a desktop, which has no
 * Close, and by the Close of a phone's sheet.
 */
async function leave(page: Page, composer: Locator) {
  if (IS_PHONE) await composer.getByRole('button', { name: 'Close' }).click();
  else await page.keyboard.press('Escape');
  await composer.waitFor({ state: 'detached' });
}

/** Goes to the unified Drafts, through the folders on a phone. */
async function goToDrafts(page: Page) {
  if (IS_PHONE) {
    // A pane off a phone's screen is inert, so only the reader's own Back is in view.
    const back = page.getByRole('button', { name: 'Back' });
    if (await back.evaluate((button) => !button.closest('[inert]'))) await back.click();
    await page.getByRole('button', { name: 'Folders', exact: true }).click();
  }
  await page
    .getByRole('button', { name: /^Drafts/ })
    .first()
    .click();
}

test('a reply is saved as it is written, opens again with its words and files, and discards', async () => {
  const page = await inbox();
  await page.getByRole('option').first().click();
  await replyButton(page).click();
  const composer = composerNamed(page, 'Reply');
  const text = composer.getByRole('textbox', { name: 'Reply' });
  await expect(text.evaluate((node) => node === document.activeElement)).resolves.toBe(true);

  await page.keyboard.type('See you **Thursday** at noon.');
  await composer.locator('input[type="file"]:not([accept])').setInputFiles({
    name: 'agenda.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('1. Lunch\n2. The engine\n'),
  });
  await composer.getByText('agenda.txt').waitFor();
  await saved(page).waitFor({ timeout: 10_000 });
  await page.screenshot({
    path: join(SHOTS, `composer-${ENGINE.name()}-${IS_PHONE ? 'phone' : 'desktop'}.png`),
  });
  await leave(page, composer);

  // The draft joins its conversation once the Mailroom has synced Drafts, folded like a message.
  const draft = reader(page).getByRole('button', { name: /^Draft/ });
  await draft.waitFor({ timeout: 10_000 });
  await draft.click();
  const reopened = composerNamed(page, 'Reply');
  const words = reopened.getByRole('textbox', { name: 'Reply' });
  await expect(words.locator('strong').textContent()).resolves.toBe('Thursday');
  await expect(words.textContent()).resolves.toBe('See you Thursday at noon.');
  await expect(reopened.getByRole('list', { name: 'Attachments' }).textContent()).resolves.toMatch(
    /^agenda\.txt/,
  );
  // While it is written again, the draft it came from stays out of the conversation.
  await expect(draft.count()).resolves.toBe(0);

  // Discarding it moves it to the Trash, and it leaves the conversation.
  await reopened.getByRole('button', { name: 'Discard draft' }).click();
  await page.getByRole('region', { name: 'Notifications' }).getByText('Draft discarded').waitFor();
  await page.waitForTimeout(2_000);
  await expect(draft.count()).resolves.toBe(0);
}, 60_000);

test('a pasted image shows as it is pasted, once its draft is saved, and when it opens again', async () => {
  const page = await inbox();
  // The page itself never asks for a `cid:` address, which only the draft can answer.
  const asked: string[] = [];
  page.on('request', (request) => {
    if (/^cid:/i.test(request.url())) asked.push(request.url());
  });
  // A conversation of its own, where the third and fourth rows are the demo's GitHub bundles.
  await page.getByRole('option').nth(1).click();
  await replyButton(page).click();
  const composer = composerNamed(page, 'Reply');
  const text = composer.getByRole('textbox', { name: 'Reply' });
  await text.waitFor();
  await page.keyboard.type('The chart: ');
  await pasteImage(page);

  // From the pasted bytes until the draft holds them, and from the draft once it does.
  const image = text.locator('img');
  await expect(shown(image, 'blob:')).resolves.toEqual([4, 3]);
  // What is typed next goes on the line after it, rather than in its place.
  await page.keyboard.type('Up and to the right.');
  await expect(
    text
      .locator('img + p')
      .filter({ hasText: /^Up and to the right\.$/ })
      .count(),
  ).resolves.toBe(1);
  await saved(page).waitFor({ timeout: 10_000 });
  await expect(shown(image, '/messages/')).resolves.toEqual([4, 3]);
  await leave(page, composer);

  const draft = reader(page).getByRole('button', { name: /^Draft/ });
  await draft.waitFor({ timeout: 10_000 });
  await draft.click();
  const reopened = composerNamed(page, 'Reply');
  const again = reopened.getByRole('textbox', { name: 'Reply' }).locator('img');
  await expect(shown(again, '/messages/')).resolves.toEqual([4, 3]);
  await reopened.getByRole('button', { name: 'Discard draft' }).click();
  await reopened.waitFor({ state: 'detached' });
  expect(asked).toEqual([]);
}, 60_000);

test('pasted HTML brings no remote image, which never loads, even as the composer closes', async () => {
  const page = await inbox();
  const tracked: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('tracker.example')) tracked.push(request.url());
  });
  await page.keyboard.press('c');
  const composer = composerNamed(page, 'New message');
  const text = composer.getByRole('textbox', { name: 'Message' });
  await text.click();
  await page.evaluate(() => {
    const pasted = new DataTransfer();
    pasted.setData(
      'text/html',
      '<p>Pasted <b>words</b><img src="https://tracker.example/pixel.png" alt="pixel"></p>',
    );
    document.activeElement?.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: pasted, bubbles: true, cancelable: true }),
    );
  });
  await text.locator('strong').waitFor();
  await expect(text.locator('img').count()).resolves.toBe(0);
  await leave(page, composer);
  await page.waitForTimeout(500);
  expect(tracked).toEqual([]);
}, 60_000);

/** A 4 by 3 pixel PNG, pasted into the editor as a browser hands a pasted file to the page. */
async function pasteImage(page: Page) {
  await page.evaluate(() => {
    const png =
      'iVBORw0KGgoAAAANSUhEUgAAAAQAAAADCAIAAAA7ljmRAAAAGElEQVR4nGOQ91/86aA3hGSAs4AkA7IMAGQcEltTdKHYAAAAAElFTkSuQmCC';
    const bytes = Uint8Array.from(atob(png), (char) => char.charCodeAt(0));
    const pasted = new DataTransfer();
    pasted.items.add(new File([bytes], 'chart.png', { type: 'image/png' }));
    document.activeElement?.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: pasted, bubbles: true, cancelable: true }),
    );
  });
}

/** The size of an image once it shows from where its `src` starts with `from`. */
async function shown(image: Locator, from: 'blob:' | '/messages/') {
  await image.and(image.page().locator(`img[src^="${from}"]`)).waitFor({ timeout: 10_000 });
  return image.evaluate(async (img: HTMLImageElement) => {
    await img.decode();
    return [img.naturalWidth, img.naturalHeight];
  });
}

test('Undo of a send that carried changes brings back its files, which save and show from the draft it filed', async () => {
  const page = await inbox();
  await page.getByRole('option').first().click();
  await replyButton(page).click();
  const reply = composerNamed(page, 'Reply');
  const text = reply.getByRole('textbox', { name: 'Reply' });
  await text.waitFor();
  await page.keyboard.type('See you at noon. ');
  await pasteImage(page);
  await reply.locator('input[type="file"]:not([accept])').setInputFiles({
    name: 'agenda.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('1. Lunch\n2. The engine\n'),
  });
  await saved(page).waitFor({ timeout: 10_000 });
  const image = text.locator('img');
  await shown(image, '/messages/');
  const before = (await image.getAttribute('src'))!;

  // Sent before the change saves, so Send carries it, and the draft it is filed as replaces the one
  // the files were named by.
  await page.keyboard.type(' Bring the map.');
  const carried = page.waitForRequest((request) => {
    const asked = request.postData() ?? '';
    return asked.includes('"send"') && asked.includes('Bring the map.');
  });
  await page.keyboard.press('ControlOrMeta+Enter');
  await reply.waitFor({ state: 'detached' });
  await carried;
  const line = reader(page).locator('div:has(> [data-airmail])', { hasText: 'Bring the map.' });
  await line.getByText(/^Sending in \d+s$/).waitFor();
  await line.getByRole('button', { name: 'Undo' }).click();
  await expect(text.textContent({ timeout: 10_000 })).resolves.toContain('Bring the map.');

  // The files are named by the draft the send filed, and still show and save once the Mailroom has
  // let the replaced draft's bytes go.
  await image
    .and(page.locator(`img[src^="/messages/"]:not([src="${before}"])`))
    .waitFor({ timeout: 10_000 });
  const isGone = () =>
    page.evaluate(async (was) => !(await fetch(was, { cache: 'no-store' })).ok, before);
  for (const by = Date.now() + 30_000; !(await isGone()); await page.waitForTimeout(500)) {
    if (Date.now() > by) throw new Error('The replaced draft’s bytes are still kept.');
  }
  await expect(shown(image, '/messages/')).resolves.toEqual([4, 3]);
  const saving = page.waitForResponse((response) =>
    Boolean(response.request().postData()?.includes('saveDraft')),
  );
  await text.getByText('Bring the map.').click();
  await page.keyboard.type(' Again.');
  await expect((await saving).text()).resolves.not.toContain('"error"');
  await saved(page).waitFor({ timeout: 10_000 });
  await expect(reply.getByRole('list', { name: 'Attachments' }).textContent()).resolves.toMatch(
    /^agenda\.txt/,
  );
}, 90_000);

test('a new message sent counts down in a toast, since it has no conversation on screen', async () => {
  const page = await inbox();
  await page.keyboard.press('c');
  const composer = composerNamed(page, 'New message');
  await composer.getByRole('combobox', { name: 'To' }).fill('sam@trailmix.test');
  await composer.getByRole('textbox', { name: 'Subject' }).fill('Trailhead at eight');
  await composer.getByRole('textbox', { name: 'Message' }).click();
  await page.keyboard.type('Bring the map.');
  await saved(page).waitFor({ timeout: 10_000 });
  await page.keyboard.press('ControlOrMeta+Enter');
  await composer.waitFor({ state: 'detached' });

  const notifications = page.getByRole('region', { name: 'Notifications' });
  await notifications.getByText(/^Sending to \S+ in \d+s$/).waitFor();
  await notifications.getByRole('button', { name: 'Undo' }).click();
  await expect(
    composer.getByRole('textbox', { name: 'Message' }).textContent({ timeout: 10_000 }),
  ).resolves.toBe('Bring the map.');
}, 60_000);

test('To completes from the people in the mail, by keys on a desktop and by a tap on a phone', async () => {
  const page = await inbox();
  await page.keyboard.press('c');
  const composer = composerNamed(page, 'New message');
  const to = composer.getByRole('combobox', { name: 'To' });
  const people = page.getByRole('listbox', { name: 'People' });
  const person = (name: string) => people.getByRole('option', { name: new RegExp(`^${name}`) });
  await to.click();

  await page.keyboard.type('the');
  await person('Theo Lindqvist').waitFor();
  await expect(to.getAttribute('aria-expanded')).resolves.toBe('true');
  if (IS_PHONE) {
    // Every person is a finger's target, and a tap picks one and leaves the keyboard up.
    expect((await person('Theo Lindqvist').boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await person('Theo Lindqvist').tap();
  } else {
    await page.keyboard.press('Enter');
  }
  await people.waitFor({ state: 'hidden' });
  await expect(to.inputValue()).resolves.toBe('Theo Lindqvist <theo@example.com>, ');

  // What's typed next completes the next address, and the list reads in both themes.
  await page.keyboard.type('pri');
  await person('Priya Raman').waitFor();
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme });
    // A theme changes over 125 ms, and a screen read mid-change has colors from both.
    await atRest(page);
    expect({ colorScheme, unreadable: await unreadableText(page) }).toEqual({
      colorScheme,
      unreadable: [],
    });
  }
  if (IS_PHONE) {
    await person('Priya Raman').tap();
  } else {
    // Escape closes the list and leaves the composer open, and typing on opens it again.
    await page.keyboard.press('Escape');
    await people.waitFor({ state: 'hidden' });
    await page.keyboard.type('y');
    await person('Priya Raman').waitFor();
    // Tab picks too, and keeps the focus in the field for the next.
    await page.keyboard.press('Tab');
  }
  await expect(to.inputValue()).resolves.toBe(
    'Theo Lindqvist <theo@example.com>, Priya Raman <priya@example.com>, ',
  );
  await expect(to.evaluate((field) => field === document.activeElement)).resolves.toBe(true);
}, 60_000);

test('Link turns the selected words into a link, adding https to an address typed without it', async () => {
  const page = await inbox();
  await page.keyboard.press('c');
  const composer = composerNamed(page, 'New message');
  await composer.getByRole('textbox', { name: 'Message' }).click();
  await page.keyboard.type('the plan');
  // Select the words by arrow keys, which every platform reads alike. Ctrl+A on Linux reaches a
  // touch WebKit as iOS's Ctrl+A, which moves to the start of the line.
  for (let at = 0; at < 'the plan'.length; at++) await page.keyboard.press('Shift+ArrowLeft');
  await composer.getByRole('button', { name: 'Link', exact: true }).click();
  // The words chosen as Link was pressed are the ones it links, even once the selection has moved,
  // as Safari moves it when the focus goes to the address.
  await composer.getByRole('textbox', { name: 'Message' }).press('ArrowRight');
  await composer.getByRole('textbox', { name: 'Link address' }).fill('example.com/plan');
  await page.keyboard.press('Enter');
  const link = composer.getByRole('textbox', { name: 'Message' }).getByRole('link');
  await expect(link.getAttribute('href')).resolves.toBe('https://example.com/plan');
  await expect(link.textContent()).resolves.toBe('the plan');
  // Pressed while the cursor is in a link, Link takes it away again.
  await composer.getByRole('button', { name: 'Link', exact: true }).click();
  await expect(link.count()).resolves.toBe(0);
}, 60_000);

test('a draft another client wrote as HTML opens with its words, and closed untouched stays as it was', async () => {
  const page = await inbox();
  // Every command this browser sends, by name, to find any that could change the draft.
  const sent: string[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST') sent.push(request.postData() ?? '');
  });
  await goToDrafts(page);
  await page.getByRole('option').filter({ hasText: 'Offsite agenda' }).click();
  const line = reader(page).getByRole('button', { name: /^Draft/ });
  await line.click();

  const words = composerNamed(page, 'New message').getByRole('textbox', { name: 'Message' });
  await words.getByRole('listitem').first().waitFor();
  await expect(words.textContent()).resolves.toBe(
    'Draft agenda for the offsite:Morning: walk through the planLunchAfternoon: review the mobile layout',
  );
  await expect(words.locator('strong').textContent()).resolves.toBe('offsite');
  await expect(words.locator('em').textContent()).resolves.toBe('mobile layout');
  await expect(words.getByRole('link').getAttribute('href')).resolves.toBe(
    'https://example.org/plan',
  );
  await expect(words.getByRole('listitem').count()).resolves.toBe(3);

  await leave(page, composerNamed(page, 'New message'));
  await page.waitForTimeout(SAVE_AFTER_MS + 1_000);
  expect(sent.filter((body) => /saveDraft|"move"/.test(body))).toEqual([]);
  await line.waitFor();
}, 60_000);

// A phone's sheet lies over everything and leaves by its Close.
if (!IS_PHONE) {
  test('a desktop leaves a reply for another conversation, and a new message for another view or by Escape, keeping each', async () => {
    const page = await inbox();
    const row = (subject: string) => page.getByRole('option').filter({ hasText: subject });
    await row('Design review notes').click();
    await replyButton(page).click();
    const reply = composerNamed(page, 'Reply');
    await reply.getByRole('textbox', { name: 'Reply' }).waitFor();
    await page.keyboard.type('Left for another conversation.');
    await row('Trip photos').click();
    await reply.waitFor({ state: 'detached' });
    await row('Design review notes').click();
    await reader(page)
      .getByRole('button', { name: /^Draft/ })
      .filter({ hasText: 'Left for another conversation.' })
      .waitFor({ timeout: 10_000 });

    // From the Outbox, which opens no conversation, so the new message belongs to none.
    const sidebar = page.getByRole('navigation', { name: 'Mailboxes' });
    await sidebar.getByRole('button', { name: /^Outbox/ }).click();
    const forView = `Left for a view ${Date.now()}`;
    const forEscape = `Left by Escape ${Date.now()}`;
    const written = composerNamed(page, 'New message');
    for (const [subject, leaveIt] of [
      [
        forView,
        () =>
          sidebar
            .getByRole('button', { name: /^Inbox/ })
            .first()
            .click(),
      ],
      [forEscape, () => page.keyboard.press('Escape')],
    ] as const) {
      await page.keyboard.press('c');
      await written.getByRole('textbox', { name: 'Subject' }).fill(subject);
      await written.getByRole('textbox', { name: 'Message' }).click();
      await page.keyboard.type('Bring the map.');
      await leaveIt();
      await written.waitFor({ state: 'detached' });
    }
    await goToDrafts(page);
    await row(forView).waitFor({ timeout: 10_000 });
    await row(forEscape).waitFor({ timeout: 10_000 });
  }, 60_000);
}

test('a tab closed mid-sentence keeps all but the last few seconds of what was written', async () => {
  const page = await inbox();
  const subject = `Mid-sentence ${Date.now()}`;
  await page.keyboard.press('c');
  const composer = composerNamed(page, 'New message');
  await page.keyboard.type('grace@example.com');
  await composer.getByRole('textbox', { name: 'Subject' }).fill(subject);
  await composer.getByRole('textbox', { name: 'Message' }).click();

  // Words go in steadily, with no pause long enough to save after, until the tab closes.
  const typed: { word: string; at: number }[] = [];
  const until = performance.now() + SAVE_AT_LEAST_EVERY_MS * 2.5;
  for (let at = 0; performance.now() < until; at++) {
    const word = `w${at}`;
    await page.keyboard.type(`${word} `);
    typed.push({ word, at: performance.now() });
    await page.waitForTimeout(100);
  }
  // At worst, the network goes with the tab, so the save the page makes as it hides never lands.
  const closedAt = performance.now();
  await page.context().setOffline(true);
  await page.close();

  const again = await inbox();
  await goToDrafts(again);
  await again.getByRole('option').filter({ hasText: subject }).click();
  await reader(again)
    .getByRole('button', { name: /^Draft/ })
    .click();
  const kept = await composerNamed(again, 'New message')
    .getByRole('textbox', { name: 'Message' })
    .textContent();
  const words = new Set(kept?.split(/\s+/));
  // A save starts at least that often while typing goes on, and takes a moment to land.
  const mustKeep = typed.filter(({ at }) => at < closedAt - SAVE_AT_LEAST_EVERY_MS - 1_000);
  expect(mustKeep.length).toBeGreaterThan(10);
  expect(mustKeep.filter(({ word }) => !words.has(word))).toEqual([]);
}, 60_000);

test('a save whose answer was lost is asked again under its id, and Drafts keeps one copy with every word', async () => {
  const page = await inbox();
  const subject = `Unanswered ${Date.now()}`;
  // The Mailroom files the first save, and its answer is lost on the way back.
  const lost = Promise.withResolvers<void>();
  let asks = 0;
  await page.route('**/_serverFn/**', async (route) => {
    if (!route.request().postData()?.includes('saveDraft') || asks++ > 0) return route.fallback();
    await route.fetch();
    await route.abort('failed');
    lost.resolve();
  });
  await page.keyboard.press('c');
  const composer = composerNamed(page, 'New message');
  await page.keyboard.type('grace@example.com');
  await composer.getByRole('textbox', { name: 'Subject' }).fill(subject);
  await composer.getByRole('textbox', { name: 'Message' }).click();
  await page.keyboard.type('Written before.');
  await lost.promise;
  // What's written while it's asked again saves once it's answered.
  await page.keyboard.type(' And while.');
  await saved(page).waitFor({ timeout: 15_000 });
  await leave(page, composer);

  await goToDrafts(page);
  const rows = page.getByRole('option').filter({ hasText: subject });
  await rows.first().click();
  const drafts = reader(page).getByRole('button', { name: /^Draft/ });
  await drafts.filter({ hasText: 'Written before. And while.' }).waitFor({ timeout: 10_000 });
  await rows.nth(1).waitFor({ state: 'detached' });
  await drafts.nth(1).waitFor({ state: 'detached' });
  expect(asks).toBeGreaterThan(1);
}, 60_000);
