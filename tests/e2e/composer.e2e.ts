import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { chromium, type Browser, type Page } from 'playwright';
import { SAVE_AFTER_MS, SAVE_AT_LEAST_EVERY_MS } from '../../src/features/composer/core/session.ts';
import { startPreview, type Preview } from './preview.ts';

/**
 * Writing, end to end: the built app on workerd with a member's demo mail. What the member writes
 * is saved to the account's Drafts as it goes, so a tab closed mid-sentence loses at most the last
 * few seconds, and a draft opened again comes back as it was written.
 */

const MEMBER = `composer-${Date.now()}@trailmix.test`;
const DESKTOP = { viewport: { width: 1440, height: 900 } };

let preview: Preview;
let browser: Browser;

beforeAll(async () => {
  preview = await startPreview({ DEV_MEMBER: MEMBER });
  browser = await chromium.launch();
}, 60_000);

/** Every error a page threw during a test, which fails it. */
const errors: string[] = [];
afterEach(() => {
  expect(errors.splice(0)).toEqual([]);
});

afterAll(async () => {
  await browser?.close();
  await preview?.stop();
});

/** A browser on the unified Inbox, once the Mailroom has filled it. */
async function inbox(): Promise<Page> {
  const page = await (await browser.newContext(DESKTOP)).newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(preview.url);
  await page.getByText('Up to date').waitFor({ state: 'attached', timeout: 30_000 });
  return page;
}

const reader = (page: Page) => page.getByRole('region', { name: 'Reader' });
const saved = (page: Page) => page.getByRole('status').filter({ hasText: 'Saved to Drafts' });

test('a reply is saved as it is written, opens again with its words and files, and discards', async () => {
  const page = await inbox();
  await page.getByRole('option').first().click();
  await reader(page).getByRole('button', { name: 'Reply', exact: true }).click();
  const composer = page.getByRole('region', { name: 'Reply' });
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
  await composer.getByRole('button', { name: 'Close' }).click();
  await composer.waitFor({ state: 'detached' });

  // The draft joins its conversation once the Mailroom has synced Drafts, folded like a message.
  const draft = reader(page).getByRole('button', { name: /^Draft/ });
  await draft.waitFor({ timeout: 10_000 });
  await draft.click();
  const reopened = page.getByRole('region', { name: 'Reply' });
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

test('a draft another client wrote as HTML opens with its words, and closed untouched stays as it was', async () => {
  const page = await inbox();
  // Every command this browser sends, by name, to find any that could change the draft.
  const sent: string[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST') sent.push(request.postData() ?? '');
  });
  await page
    .getByRole('button', { name: /^Drafts/ })
    .first()
    .click();
  await page.getByRole('option').filter({ hasText: 'Offsite agenda' }).click();
  const line = reader(page).getByRole('button', { name: /^Draft/ });
  await line.click();

  const words = page
    .getByRole('region', { name: 'New message' })
    .getByRole('textbox', { name: 'Message' });
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
  const composer = page.getByRole('region', { name: 'New message' });
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
  await again
    .getByRole('button', { name: /^Drafts/ })
    .first()
    .click();
  await again.getByRole('option').filter({ hasText: subject }).click();
  await reader(again)
    .getByRole('button', { name: /^Draft/ })
    .click();
  const kept = await again
    .getByRole('region', { name: 'New message' })
    .getByRole('textbox', { name: 'Message' })
    .textContent();
  const words = new Set(kept?.split(/\s+/));
  // A save starts at least that often while typing goes on, and takes a moment to land.
  const mustKeep = typed.filter(({ at }) => at < closedAt - SAVE_AT_LEAST_EVERY_MS - 1_000);
  expect(mustKeep.length).toBeGreaterThan(10);
  expect(mustKeep.filter(({ word }) => !words.has(word))).toEqual([]);
}, 60_000);
