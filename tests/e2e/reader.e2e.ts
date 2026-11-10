import { afterEach, beforeAll, expect } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { BrowserContextOptions, Page } from 'playwright';
import { unreadableText } from './contrast.ts';
import { suite } from './suite.ts';

/**
 * The reader around a conversation, end to end on the demo mailbox: the folder it lies in, a reply
 * and the source of any one of its messages, and on a phone the marks at the top of the screen and
 * the filing in the island.
 */

const SHOTS = join(import.meta.dir, '../../test-results');
const DESKTOP = { viewport: { width: 1440, height: 900 } };
const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true };

const app = suite({ vars: { DEV_MEMBER: `reader-${Date.now()}@trailmix.test` } });
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

async function open(options: BrowserContextOptions): Promise<Page> {
  const page = await (await app.context({ deviceScaleFactor: 2, ...options })).newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(app.url);
  await page.getByText('Up to date').waitFor({ state: 'attached', timeout: 30_000 });
  return page;
}

const reader = (page: Page) => page.getByRole('region', { name: 'Reader' });
const row = (page: Page, subject: string) =>
  page.getByRole('option').filter({ hasText: subject }).first();
/** Waits for the line under the subject, the account, the folder and how many messages, to say this. */
const says = (page: Page, line: string | RegExp) =>
  reader(page).getByText(line, { exact: true }).waitFor({ timeout: 2_000 });
const folder = (page: Page, account: string, name: string) =>
  page
    .getByRole('region', { name: account })
    .getByRole('button', { name: new RegExp(`^${name}( \\d+)?$`) });

async function readable(page: Page, screen: string) {
  await page.screenshot({ path: join(SHOTS, `reader-${screen}.png`) });
  expect({ screen, unreadable: await unreadableText(page) }).toEqual({ screen, unreadable: [] });
}

test('the line under the subject names the folder the conversation lies in', async () => {
  const page = await open({ ...DESKTOP, colorScheme: 'light' });
  await row(page, 'Workers migration plan').click();
  await says(page, 'Personal · Inbox · 3 messages');
  await readable(page, 'desktop-light');

  // A draft's own line says what it is, so the count is of the mail alone.
  await row(page, 'Lunch Thursday?').click();
  await reader(page)
    .getByRole('button', { name: /^Draft/ })
    .waitFor();
  await says(page, 'Personal · Inbox · 1 message');

  // Opened from Sent, where the member's own reply is, it still lies in the Inbox.
  await folder(page, 'Personal', 'Sent').click();
  await row(page, 'Workers migration plan').click();
  await says(page, 'Personal · Inbox · 3 messages');

  await folder(page, 'Personal', 'Archive').click();
  await page.getByRole('option').first().click();
  await says(page, /^Personal · Archive · \d+ messages?$/);
}, 30_000);

test('each message answers and shows the source of its own, and the palette the newest', async () => {
  const page = await open({ ...DESKTOP, colorScheme: 'dark' });
  await row(page, 'Q4 planning').click();
  const newest = reader(page).getByRole('article');
  const newestName = (await newest.getAttribute('aria-label'))!.replace('Message from ', '');
  // The bar files and marks the conversation, and each message holds its own Reply.
  const bar = page.getByRole('toolbar', { name: 'Conversation' });
  await bar.getByRole('button', { name: 'Archive' }).waitFor();
  await expect(bar.getByRole('button', { name: /^Reply/ }).count()).resolves.toBe(0);
  const senders = await reader(page).locator('button strong').allTextContents();
  const earlierName = senders.find((name) => ![newestName, 'You', 'Draft'].includes(name))!;

  // R answers the newest message, and the arrow on an earlier one answers that one.
  const to = page.getByRole('region', { name: 'Reply' }).getByRole('textbox', { name: 'To' });
  const answered = async () => {
    const value = await to.inputValue();
    await page.keyboard.press('Escape');
    await to.waitFor({ state: 'detached' });
    return value;
  };
  await page.keyboard.press('r');
  const newestTo = await answered();
  expect(newestTo).toContain(newestName);
  await reader(page)
    .getByRole('button')
    .filter({ has: page.locator('strong', { hasText: earlierName }) })
    .first()
    .click();
  const earlier = reader(page).getByRole('article', { name: `Message from ${earlierName}` });
  await earlier.getByRole('button', { name: 'Reply', exact: true }).click();
  const earlierTo = await answered();
  expect(earlierTo).toContain(earlierName);
  // Only the newest message's Reply teaches R, the key that answers it.
  const tooltip = async (article: typeof earlier) => {
    await article.getByRole('button', { name: 'Reply', exact: true }).hover();
    const shown = page.getByRole('tooltip').filter({ hasText: /^Reply/ });
    await shown.waitFor();
    const text = await shown.textContent();
    await page.mouse.move(0, 0);
    await shown.waitFor({ state: 'detached' });
    return text;
  };
  await expect(tooltip(newest.last())).resolves.toBe('Reply (R)');
  await expect(tooltip(earlier)).resolves.toBe('Reply');

  // Its source, from its own menu, is from its own sender.
  const source = page.getByRole('dialog');
  const from = source
    .locator('dt', { hasText: /^From$/ })
    .locator('xpath=following-sibling::dd[1]');
  const address = (to: string) => /<([^>]+)>/.exec(to)?.[1] ?? to;
  await earlier.getByRole('button', { name: 'More for this message' }).click();
  await page.getByRole('menuitem', { name: 'View source' }).click();
  await source.getByText('Loading the source…').waitFor({ state: 'detached' });
  await expect(from.textContent()).resolves.toContain(address(earlierTo));
  await readable(page, 'desktop-dark-source');
  await page.keyboard.press('Escape');
  await source.waitFor({ state: 'detached' });

  // The palette's opens the newest message's.
  await page.keyboard.press('ControlOrMeta+k');
  await page.keyboard.type('view source');
  await page.getByRole('option', { name: 'View source' }).waitFor();
  await page.keyboard.press('Enter');
  await source.getByText('Loading the source…').waitFor({ state: 'detached' });
  await expect(from.textContent()).resolves.toContain(address(newestTo));
}, 30_000);

for (const colorScheme of ['light', 'dark'] as const) {
  test(`on a phone, in ${colorScheme}, the top of the screen marks and the island files`, async () => {
    const page = await open({ ...PHONE, colorScheme });
    // Each scheme marks a conversation of its own, as both share the member's mailbox.
    const subject = colorScheme === 'light' ? 'Workers migration plan' : 'Lunch Thursday?';
    await row(page, subject).click();
    const top = page.getByRole('toolbar', { name: 'Marks' });
    const island = page.getByRole('toolbar', { name: 'Conversation' });
    await top.getByRole('button', { name: 'Flag', exact: true }).waitFor();
    await readable(page, `phone-${colorScheme}`);

    /** Each button's name, from its label or else its word. */
    const names = (toolbar: typeof top) =>
      toolbar
        .getByRole('button')
        .evaluateAll((buttons) =>
          buttons.map((button) => button.getAttribute('aria-label') ?? button.textContent?.trim()),
        );
    await expect(names(top)).resolves.toEqual(['Flag', 'More']);
    await expect(names(island)).resolves.toEqual(['Archive', 'Delete', 'Move to', 'Reply']);
    expect(await reader(page).getByRole('button', { name: 'Back', exact: true }).isVisible()).toBe(
      true,
    );

    await top.getByRole('button', { name: 'Flag', exact: true }).click();
    await top.getByRole('button', { name: 'Unflag', exact: true }).waitFor({ timeout: 1_000 });
    await top.getByRole('button', { name: 'More' }).click();
    await page.getByRole('menuitem', { name: 'Mark unread' }).click();
    await row(page, subject)
      .getByText('Unread', { exact: true })
      .waitFor({ state: 'attached', timeout: 1_000 });

    // The source of a message, from its own menu.
    await reader(page)
      .getByRole('article')
      .getByRole('button', { name: 'More for this message' })
      .click();
    await page.getByRole('menuitem', { name: 'View source' }).click();
    await page.getByRole('dialog').getByText('Message-ID', { exact: true }).waitFor();
  }, 30_000);
}
