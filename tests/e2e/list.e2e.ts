import { expect } from 'bun:test';
import type { BrowserContextOptions, Page } from 'playwright';
import { PAGE_SIZE } from '../../src/features/mailroom/client/contract.ts';
import { suite } from './suite.ts';

/**
 * The conversation list: a long list as it changes under the member, as mail arrives while it is
 * scrolled down, and the avatars that lead its rows. Its own member, since what it sends lands in
 * the Inbox the other suites read, and it removes an account.
 */

const app = suite({ vars: { DEV_MEMBER: `list-${Date.now()}@trailmix.test` } });
// A test that fails leaves a screenshot of each page and what it showed, for CI to keep.
const { test } = app;

const DESKTOP = { viewport: { width: 1440, height: 900 } };
const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true };

/**
 * The rows drawn where the list is scrolled. The conversation open, the Inbox's newest, stays drawn
 * at the top wherever the list is scrolled, so it's left out.
 */
const SCROLLED = '[role="option"]:not([aria-selected="true"])';

/** The Inbox, at a desktop's size unless told, recording every error and failed response. */
async function open(options: BrowserContextOptions = DESKTOP) {
  const context = await app.context(options);
  const page = await context.newPage();
  const problems: string[] = [];
  page.on('pageerror', (error) => problems.push(`page error: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(`console: ${message.text()}`);
  });
  page.on('response', (response) => {
    if (response.status() >= 400) problems.push(`${response.status()} ${response.url()}`);
  });
  await page.goto(app.url, { waitUntil: 'networkidle' });
  await page.getByText('Up to date').waitFor({ state: 'attached', timeout: 30_000 });
  return { context, page, problems };
}

test('mail that arrives while the list is scrolled down moves nothing in sight, and leads it at the top', async () => {
  const { context, page, problems } = await open();
  const list = page.locator('[role="listbox"][aria-multiselectable]');
  const length = async () =>
    Number(await list.getByRole('option').first().getAttribute('aria-setsize'));
  const before = await length();
  // Halfway down the Inbox, far past its first page, once the rows there have arrived.
  await list.evaluate((list) => (list.scrollTop = list.scrollHeight / 2));
  await page.waitForFunction(
    ({ page, drawn }) => {
      const list = document.querySelector('[role="listbox"][aria-multiselectable]');
      const first = Number(list?.querySelector(drawn)?.getAttribute('aria-posinset'));
      return list?.getAttribute('aria-busy') === 'false' && first > page;
    },
    { page: PAGE_SIZE, drawn: SCROLLED },
  );
  const inSight = () =>
    list.evaluate((list) => {
      const top = list.getBoundingClientRect().top;
      return [...list.querySelectorAll('[role="option"]')].flatMap((row) => {
        const at = Math.round(row.getBoundingClientRect().top - top);
        return at >= 0 && at < list.clientHeight ? [`${at}: ${row.textContent}`] : [];
      });
    });
  const seen = await inSight();
  expect(seen.length).toBeGreaterThan(5);

  // The demo delivers what Sam sends Sam to Sam's Inbox once its send goes.
  const subject = `Arrived while scrolled down ${Date.now()}`;
  await page.keyboard.press('c');
  const composer = page.locator('section[aria-label="New message"]');
  await composer.getByRole('textbox', { name: 'To' }).fill('sam@trailmix.test');
  await composer.getByRole('textbox', { name: 'Subject' }).fill(subject);
  await page.getByRole('status').filter({ hasText: 'Saved to Drafts' }).waitFor();
  await page.getByRole('button', { name: 'Send', exact: true }).filter({ visible: true }).click();
  await page.waitForFunction(
    (before) =>
      Number(document.querySelector('[role="option"]')?.getAttribute('aria-setsize')) > before,
    before,
    { timeout: 30_000 },
  );

  expect(await length()).toBe(before + 1);
  expect(await inSight()).toEqual(seen);
  await list.evaluate((list) => (list.scrollTop = 0));
  await list.getByRole('option').first().filter({ hasText: subject }).waitFor({ timeout: 5_000 });
  expect(problems).toEqual([]);
  await context.close();
}, 60_000);

test('a list dragged far down asks for no page on the way, only for where it stops', async () => {
  const { context, page, problems } = await open();
  const list = page.locator('[role="listbox"][aria-multiselectable]');
  await list.getByRole('option').first().waitFor();
  // The places of the pages the list asks for, past its first.
  const asked: number[] = [];
  page.on('request', (request) => {
    const payload = decodeURIComponent(request.url());
    const at = /"s":"conversations".*?"t":0,"s":(\d+)/.exec(payload)?.[1];
    if (at && Number(at) > 0) asked.push(Number(at));
  });

  // A thumb dragged halfway down over half a second, the list moving a long way each frame.
  await list.evaluate(
    (list) =>
      new Promise<void>((resolve) => {
        let frame = 0;
        const step = () => {
          list.scrollTop = (list.scrollHeight / 2) * (++frame / 30);
          if (frame < 30) requestAnimationFrame(step);
          else resolve();
        };
        requestAnimationFrame(step);
      }),
  );
  const onTheWay = asked.length;
  await page.waitForFunction((drawn) => {
    const list = document.querySelector('[role="listbox"][aria-multiselectable]');
    return list?.getAttribute('aria-busy') === 'false' && list.querySelector(drawn);
  }, SCROLLED);
  const first = Number(await list.locator(SCROLLED).first().getAttribute('aria-posinset'));

  expect(onTheWay).toBe(0);
  // The pages in sight where it stopped, with the rows either side that arrive ahead.
  expect(asked.length).toBeGreaterThan(0);
  expect(asked.every((at) => Math.abs(at - first) < 2 * PAGE_SIZE)).toBe(true);
  expect(problems).toEqual([]);
  await context.close();
}, 30_000);

test('End selects the last conversation once its page arrives', async () => {
  const { context, page, problems } = await open();
  const list = page.locator('[role="listbox"][aria-multiselectable]');
  const length = Number(await list.getByRole('option').first().getAttribute('aria-setsize'));
  expect(length).toBeGreaterThan(PAGE_SIZE);

  await list.focus();
  await page.keyboard.press('End');
  await list
    .locator(`[role="option"][aria-selected="true"][aria-posinset="${length}"]`)
    .waitFor({ timeout: 5_000 });
  expect(problems).toEqual([]);
  await context.close();
}, 30_000);

test('a row leads with its sender’s logo when verified, or their initials, the same as the reader’s sheet', async () => {
  const { context, page, problems } = await open();
  // Kernel Weekly's mail is verified and has a logo. Kwame writes as himself.
  const logo = avatarOf(page, 'Kernel Weekly').locator('img');
  await expect(
    logo.evaluate((image: HTMLImageElement) => image.naturalWidth),
  ).resolves.toBeGreaterThan(0);
  expect(await avatarOf(page, 'Kwame Mensah').textContent()).toBe('KM');
  // The avatar is the newest sender who isn't the member: Sam is the member here.
  expect(await avatarOf(page, 'Sam, Jonas').textContent()).toBe('JW');
  for (const sender of ['Kernel Weekly', 'Kwame Mensah']) {
    const box = await avatarOf(page, sender).locator('[data-avatar]').boundingBox();
    expect([box?.width, box?.height]).toEqual([32, 32]);
  }

  await row(page, 'Kernel Weekly').click();
  const sheet = page.getByRole('article', { name: 'Message from Kernel Weekly' });
  await expect(
    sheet.locator('header img').evaluate((image: HTMLImageElement) => image.naturalWidth),
  ).resolves.toBeGreaterThan(0);
  await row(page, 'Kwame Mensah').click();
  await page
    .getByRole('article', { name: 'Message from Kwame Mensah' })
    .locator('header')
    .getByText('KM', { exact: true })
    .waitFor();
  expect(problems).toEqual([]);
  await context.close();
}, 30_000);

test('on a phone, tapping a row’s avatar picks the row, on a target 44 pixels across', async () => {
  const { context, page, problems } = await open(PHONE);
  const target = avatarOf(page, 'Kwame Mensah');
  const box = await target.boundingBox();
  expect(box!.width).toBeGreaterThanOrEqual(44);
  expect(box!.height).toBeGreaterThanOrEqual(44);

  await target.tap();
  await page.getByRole('toolbar', { name: 'Picked conversations' }).waitFor();
  await avatarOf(page, 'Kernel Weekly').tap();
  const picked = page.locator('[role="option"][aria-selected="true"]');
  await expect(picked.count()).resolves.toBe(2);
  // Picking keeps the list in view: the reader never slid over it.
  const list = page.locator('[role="listbox"][aria-multiselectable]');
  expect(await list.evaluate((list) => list.closest('[inert]') === null)).toBe(true);
  await avatarOf(page, 'Kernel Weekly').tap();
  await expect(picked.count()).resolves.toBe(1);
  expect(problems).toEqual([]);
  await context.close();
}, 30_000);

// Last, since it removes an account.
test('the stamp marks rows only where a list mixes accounts', async () => {
  const { context, page, problems } = await open();
  const stamps = () => page.locator('[role="option"] [data-stamp]').count();
  // The unified Inbox mixes Personal and Work.
  expect(await stamps()).toBeGreaterThan(0);
  expect(
    await avatarOf(page, 'Kwame Mensah').locator('[data-stamp]').getAttribute('data-stamp'),
  ).toBeTruthy();

  // One account's folder doesn't.
  await page
    .getByRole('region', { name: 'Personal' })
    .getByRole('button', { name: /^Inbox/ })
    .click();
  await page.getByRole('heading', { name: 'Inbox', level: 2 }).waitFor();
  await page.getByRole('option').first().waitFor();
  expect(await stamps()).toBe(0);

  // Nor does the unified Inbox of a member with one account.
  await page
    .getByRole('region', { name: 'Work' })
    .getByRole('button', { name: 'More for Work' })
    .click();
  await page.getByRole('menuitem', { name: 'Remove the Work account' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Remove' }).click();
  await page.getByRole('region', { name: 'Work' }).waitFor({ state: 'detached' });
  await page
    .getByRole('button', { name: /^Inbox/ })
    .first()
    .click();
  await page.getByRole('option').first().waitFor();
  expect(await stamps()).toBe(0);
  expect(problems).toEqual([]);
  await context.close();
}, 30_000);

/** The list's first row from a sender, or with these senders. */
const row = (page: Page, senders: string) =>
  page.getByRole('option').filter({ hasText: senders }).first();

/** The avatar leading a row, where a finger taps it. */
const avatarOf = (page: Page, senders: string) =>
  row(page, senders).locator(':scope > span').first();
