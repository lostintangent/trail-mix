import { afterEach, beforeAll, expect, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, webkit, type Locator, type Page } from 'playwright';
import { SAVE_AFTER_MS, SAVE_AT_LEAST_EVERY_MS } from '../../src/features/composer/core/session.ts';
import { suite } from './suite.ts';

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
  await page.getByText('Up to date').waitFor({ state: 'attached', timeout: 30_000 });
  return page;
}

const reader = (page: Page) => page.getByRole('region', { name: 'Reader' });
const saved = (page: Page) => page.getByRole('status').filter({ hasText: 'Saved to Drafts' });

/** The composer by its name, whether it lies on the page or rises as a phone's sheet. */
const composerNamed = (page: Page, name: 'Reply' | 'New message') =>
  page.locator(`section[aria-label="${name}"]`);

/** The reader's Reply: in its bar on a desktop, in its island on a phone. */
const replyButton = (page: Page) =>
  reader(page).getByRole('button', { name: 'Reply', exact: true }).filter({ visible: true });

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
  await composer.getByRole('button', { name: 'Close' }).click();
  await composer.waitFor({ state: 'detached' });

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
  await page.getByRole('option').nth(3).click();
  await replyButton(page).click();
  const composer = composerNamed(page, 'Reply');
  const text = composer.getByRole('textbox', { name: 'Reply' });
  await text.waitFor();
  await page.keyboard.type('The chart: ');
  await pasteImage(page);

  // From the pasted bytes until the draft holds them, and from the draft once it does.
  const image = text.locator('img');
  await expect(shown(image, 'blob:')).resolves.toEqual([4, 3]);
  await saved(page).waitFor({ timeout: 10_000 });
  await expect(shown(image, '/messages/')).resolves.toEqual([4, 3]);
  await composer.getByRole('button', { name: 'Close' }).click();
  await composer.waitFor({ state: 'detached' });

  const draft = reader(page).getByRole('button', { name: /^Draft/ });
  await draft.waitFor({ timeout: 10_000 });
  await draft.click();
  const reopened = composerNamed(page, 'Reply');
  const again = reopened.getByRole('textbox', { name: 'Reply' }).locator('img');
  await expect(shown(again, '/messages/')).resolves.toEqual([4, 3]);
  await reopened.getByRole('button', { name: 'Discard draft' }).click();
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

test('⌘↵ sends what was written, and Undo brings the composer back as it was', async () => {
  const page = await inbox();
  await page.getByRole('option').first().click();
  await replyButton(page).click();
  const reply = composerNamed(page, 'Reply');
  await reply.getByRole('textbox', { name: 'Reply' }).waitFor();
  await page.keyboard.type('On my way.');
  await page.keyboard.press('ControlOrMeta+Enter');
  await reply.waitFor({ state: 'detached' });

  const notifications = page.getByRole('region', { name: 'Notifications' });
  await notifications.getByText(/^Sending to \w+ in \d+s$/).waitFor();
  await notifications.getByRole('button', { name: 'Undo' }).click();
  await expect(
    reply.getByRole('textbox', { name: 'Reply' }).textContent({ timeout: 10_000 }),
  ).resolves.toBe('On my way.');
}, 60_000);

test('Link turns the selected words into a link, adding https to an address typed without it', async () => {
  const page = await inbox();
  await page.keyboard.press('c');
  const composer = composerNamed(page, 'New message');
  await composer.getByRole('textbox', { name: 'Message' }).click();
  await page.keyboard.type('the plan');
  await page.keyboard.press('ControlOrMeta+a');
  await composer.getByRole('button', { name: 'Link', exact: true }).click();
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

  await page.getByRole('button', { name: 'Close' }).click();
  await page.waitForTimeout(SAVE_AFTER_MS + 1_000);
  expect(sent.filter((body) => /saveDraft|"move"/.test(body))).toEqual([]);
  await line.waitFor();
}, 60_000);

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
