import { afterEach, beforeAll, expect } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { BrowserContextOptions, Page } from 'playwright';
import { unreadableText } from './contrast.ts';
import { suite } from './suite.ts';

/**
 * The sidebar, end to end: the built app on workerd, on a member of its own, whose demo mailbox
 * keeps its seeded folders. The sidebar folds to its rail and back, every account and folder has
 * its menu without a hover, and accounts and folders fold, as this device remembers.
 */

const SHOTS = join(import.meta.dir, '../../test-results');
const DESKTOP = { viewport: { width: 1440, height: 900 } };
const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true };

const app = suite({ vars: { DEV_MEMBER: `sidebar-${Date.now()}@trailmix.test` } });
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
  await page
    .getByRole('status')
    .filter({ hasText: 'Up to date' })
    .first()
    .waitFor({ state: 'attached', timeout: 30_000 });
  return page;
}

const personal = (page: Page) => page.getByRole('region', { name: 'Personal' });
const folderRow = (page: Page, name: string) =>
  personal(page).getByRole('button', { name: new RegExp(`^${name}( \\d+)?$`) });

async function readable(page: Page, screen: string) {
  await page.screenshot({ path: join(SHOTS, `sidebar-${screen}.png`) });
  expect({ screen, unreadable: await unreadableText(page) }).toEqual({ screen, unreadable: [] });
}

test('the sidebar folds to its rail and back by button and key, keeping every view, account and action in reach', async () => {
  const page = await open({ ...DESKTOP, colorScheme: 'dark' });
  const sidebar = page.getByRole('navigation', { name: 'Mailboxes' });
  const fold = sidebar.getByRole('button', { name: 'Fold the sidebar' });
  const unfold = sidebar.getByRole('button', { name: 'Unfold the sidebar' });
  const at = await fold.boundingBox();
  await fold.click();
  await page.waitForFunction(
    () =>
      getComputedStyle(document.documentElement).getPropertyValue('--workbench-sidebar') === '50px',
  );
  // The button holds still across the fold, and the search moves above the list.
  expect(await unfold.boundingBox()).toEqual(at);
  await page
    .getByRole('region', { name: 'Inbox' })
    .getByRole('searchbox', { name: 'Search mail' })
    .waitFor();
  for (const name of [
    /^New message/,
    /^Inbox/,
    'Flagged',
    'Drafts',
    'Outbox',
    'Add account',
    /^Theme/,
  ]) {
    await sidebar.getByRole('button', { name }).waitFor({ timeout: 1_000 });
  }
  // An account's stamp opens its Inbox.
  await readable(page, 'desktop-dark-rail');
  await sidebar.getByRole('button', { name: /^Work/ }).click();
  await page.getByRole('heading', { name: 'Inbox', level: 2 }).waitFor();
  await expect(
    sidebar.getByRole('button', { name: /^Work/ }).getAttribute('aria-current'),
  ).resolves.toBe('page');

  // Its key unfolds it, with the search back at the top.
  await page.keyboard.press('ControlOrMeta+b');
  await fold.waitFor();
  await sidebar.getByRole('searchbox', { name: 'Search mail' }).waitFor();

  // Folded again, it comes back folded from the sidebar's first render.
  await page.keyboard.press('ControlOrMeta+b');
  await unfold.waitFor();
  await page.context().addInitScript(() => {
    const first: string[] = [];
    Object.assign(window, { firstFold: first });
    new MutationObserver(() => {
      const button = document.querySelector('nav button[aria-label$="the sidebar"]');
      if (button && first.length === 0) first.push(button.getAttribute('aria-label')!);
    }).observe(document, { childList: true, subtree: true });
  });
  await page.reload({ waitUntil: 'networkidle' });
  await unfold.waitFor();
  expect(
    await page.evaluate(() => (window as unknown as { firstFold: string[] }).firstFold),
  ).toEqual(['Unfold the sidebar']);
}, 30_000);

test('every folder and account has its menu without a hover, for itself rather than the view', async () => {
  const page = await open({ ...DESKTOP, colorScheme: 'light' });
  const work = page.getByRole('region', { name: 'Work' });
  // The account's folders have arrived, so the rows and their menus are counted from the same tree.
  await work.getByRole('button', { name: /^Receipts/ }).waitFor();
  const rows = await work
    .getByRole('button', { name: /^(Inbox|Archive|Sent|Drafts|Receipts|Junk|Trash)( \d+)?$/ })
    .count();
  const menus = work.getByRole('button', { name: /^More for / });
  await expect(menus.count()).resolves.toBe(rows + 1);
  for (const menu of await menus.all()) await expect(menu.isVisible()).resolves.toBe(true);

  // Inbox is in view, and Receipts' menu acts on Receipts.
  await work.getByRole('button', { name: 'More for Receipts' }).click();
  await page.getByRole('menuitem').first().waitFor();
  await expect(page.getByRole('menuitem').allTextContents()).resolves.toEqual([
    'New folder in Receipts',
    'Rename Receipts',
    'Delete Receipts',
  ]);
  await page.getByRole('menuitem', { name: 'Rename Receipts' }).click();
  await page.getByRole('textbox', { name: 'New name for Receipts' }).press('Escape');
  await page.getByRole('heading', { name: 'Inbox', level: 2 }).waitFor();

  // An account's menu holds what can be done to it.
  await work.getByRole('button', { name: 'More for Work' }).click();
  await page.getByRole('menuitem').first().waitFor();
  await expect(page.getByRole('menuitem').allTextContents()).resolves.toEqual([
    'New folder in Work',
    'Edit the Work account',
    'Remove the Work account',
  ]);
  await readable(page, 'desktop-light-account-menu');
}, 60_000);

test('the sidebar works from the keyboard alone, its fold first and each menu as its own', async () => {
  const page = await open({ ...DESKTOP, colorScheme: 'light' });
  const focused = () =>
    page.evaluate(() => {
      const element = document.activeElement!;
      return `${element.getAttribute('role') ?? element.tagName}: ${element.getAttribute('aria-label') ?? element.textContent}`;
    });
  await page.keyboard.press('Tab');
  await expect(focused()).resolves.toBe('BUTTON: Fold the sidebar');
  // Its rows, chevrons and menus draw the focus ring every Astryx control does.
  const ring = () =>
    page.evaluate(() => {
      const { outlineStyle, outlineWidth, outlineColor } = getComputedStyle(
        document.activeElement!,
      );
      return `${outlineStyle} ${outlineWidth} ${outlineColor}`;
    });
  const astryx = await ring();
  for (const name of ['Flagged', 'Fold Projects', 'More for Toy Box']) {
    await page.getByRole('button', { name, exact: true }).first().focus();
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Tab');
    expect({ name, ring: await ring() }).toEqual({ name, ring: astryx });
  }

  // A row's menu loads as it's first opened, and still opens as a menu does from the keyboard.
  const more = page
    .getByRole('region', { name: 'Work' })
    .getByRole('button', { name: 'More for Receipts' });
  await more.focus();
  await page.keyboard.press('Enter');
  await page.getByRole('menuitem').first().waitFor();
  await expect(focused()).resolves.toBe('menuitem: New folder in Receipts');
  await page.keyboard.press('ArrowDown');
  await expect(focused()).resolves.toBe('menuitem: Rename Receipts');
  await page.keyboard.press('Escape');
  await expect(focused()).resolves.toBe('BUTTON: More for Receipts');
}, 60_000);

test('an account whose folders are on their way shows lines in their shape, which its folders take', async () => {
  const context = await app.context({ ...DESKTOP, deviceScaleFactor: 2 });
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  let release = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route('**/_serverFn/**', async (route) => {
    if (decodeURIComponent(route.request().url()).includes('"folders"')) await held;
    await route.fallback();
  });
  await page.goto(app.url);
  const listing = page.getByRole('status').filter({ hasText: /^Listing .+’s folders$/ });
  await listing.last().waitFor({ state: 'attached' });
  await expect(listing.allTextContents()).resolves.toEqual([
    'Listing Personal’s folders',
    'Listing Work’s folders',
  ]);
  release();
  await page.unrouteAll({ behavior: 'wait' });
  await folderRow(page, 'Archive').waitFor();
  await expect(listing.count()).resolves.toBe(0);
}, 60_000);

test('accounts and folders fold by click and by key, count what’s unread inside, and stay folded', async () => {
  const page = await open({ ...DESKTOP, colorScheme: 'dark' });
  const count = async (name: string) =>
    Number((await folderRow(page, name).textContent())!.replace(/\D/g, '') || 0);
  const inside = (await count('Projects')) + (await count('Toy Box'));

  // A folded folder hides what's in it, and counts its unread mail with its own.
  await personal(page).getByRole('button', { name: 'Fold Projects' }).click();
  await folderRow(page, 'Toy Box').waitFor({ state: 'detached' });
  await expect(count('Projects')).resolves.toBe(inside);
  await readable(page, 'desktop-dark-folded-folder');

  // The arrow keys on its row unfold and fold it again.
  await folderRow(page, 'Projects').focus();
  await page.keyboard.press('ArrowRight');
  await folderRow(page, 'Toy Box').waitFor();
  await page.keyboard.press('ArrowLeft');
  await folderRow(page, 'Toy Box').waitFor({ state: 'detached' });

  // A folded account hides its folders and counts their unread mail outside Junk and Trash.
  const account = personal(page).getByRole('button', { name: /^Personal/ });
  await account.click();
  await expect(account.getAttribute('aria-expanded')).resolves.toBe('false');
  await folderRow(page, 'Archive').waitFor({ state: 'detached' });
  await expect(account.textContent()).resolves.toMatch(/^Personal\d+$/);

  // This device remembers both, from its first render.
  await page.reload();
  await page.getByText('Up to date').waitFor({ state: 'attached', timeout: 30_000 });
  await expect(account.getAttribute('aria-expanded')).resolves.toBe('false');
  await account.click();
  await folderRow(page, 'Projects').waitFor();
  await expect(folderRow(page, 'Toy Box').count()).resolves.toBe(0);
}, 60_000);

test('on a phone, the sidebar never folds, and its chevrons and menus are 44 pixels', async () => {
  const page = await open({ ...PHONE, colorScheme: 'light' });
  await page.getByRole('button', { name: 'Folders', exact: true }).click();
  await expect(page.getByRole('button', { name: /the sidebar$/ }).count()).resolves.toBe(0);
  const chevron = personal(page).getByRole('button', { name: 'Fold Projects' });
  for (const control of [
    chevron,
    personal(page).getByRole('button', { name: 'More for Projects' }),
  ]) {
    const box = (await control.boundingBox())!;
    expect(Math.min(box.width, box.height)).toBeGreaterThanOrEqual(44);
  }
  await chevron.click();
  await folderRow(page, 'Toy Box').waitFor({ state: 'detached' });
  await readable(page, 'phone-light-folded');
}, 60_000);
