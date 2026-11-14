import { afterEach, expect } from 'bun:test';
import type { BrowserContextOptions, Page } from 'playwright';
import { DWELL_MS } from '../../src/features/workbench/ui/useReadMark.ts';
import { mailIsIn } from '../mailIsIn.ts';
import { suite } from './suite.ts';

/**
 * GitHub bundles, end to end: the built app on workerd, on a member of its own. Each Inbox view
 * lists one row for each repository GitHub writes about, which opens as a sheet of its threads
 * without reading any. A thread opens under it, steps to the next by J and links to itself on
 * GitHub, and the row's actions act on every thread in it, with Undo. Other views and searches list
 * the same threads as conversations.
 */

const DESKTOP = { viewport: { width: 1440, height: 900 } };
const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true };

const app = suite({ vars: { DEV_MEMBER: `github-${Date.now()}@trailmix.test` } });
const { test } = app;

/** Every error a page threw during a test, which fails it. */
const errors: string[] = [];
afterEach(() => {
  expect(errors.splice(0)).toEqual([]);
});

async function open(options: BrowserContextOptions, path = '/'): Promise<Page> {
  const page = await (await app.context(options)).newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(new URL(path, app.url).href);
  await mailIsIn(page);
  return page;
}

/** The demo's two repositories, Personal's and Work's. */
const TOY_BOX = 'trailmix-demo/toy-box';
const PIXELS = 'trailmix-demo/pixels';

/** A bundle's row, which names its repository as a sender, where a conversation's subject brackets it. */
const bundleRow = (page: Page, repository: string) =>
  page.getByRole('option').filter({ hasText: new RegExp(`(?<!\\[)${repository}(?!\\])`) });
/** Rows of a repository's GitHub mail listed as conversations, by their subjects. */
const threadRows = (page: Page, repository: string) =>
  page.getByRole('option').filter({ hasText: `[${repository}]` });
const reader = (page: Page) => page.getByRole('region', { name: 'Reader' });
/** Waits until the reader's heading reads `text`. */
const shows = (page: Page, text: string) =>
  reader(page).getByRole('heading', { level: 1, name: text, exact: true }).waitFor();
/** The thread sheets the bundle's reader shows, each opened by its title. */
const threadTitles = (page: Page) => reader(page).locator('article > div > button');
const undoButton = (page: Page) => page.getByRole('button', { name: 'Undo', exact: true });
/**
 * The thread the address opens, once the selection has rested and written it, other than `before`.
 */
const openedOnceRested = async (page: Page, before?: string) =>
  (await (
    await page.waitForFunction((before) => {
      const open = new URL(location.href).searchParams.get('open');
      return open !== null && open !== before ? open : undefined;
    }, before)
  ).jsonValue()) as string;

test('each Inbox lists one row for each repository, and a search or a folder lists its threads', async () => {
  const page = await open(DESKTOP);
  for (const repository of [TOY_BOX, PIXELS]) {
    await expect(bundleRow(page, repository).count()).resolves.toBe(1);
    await expect(threadRows(page, repository).count()).resolves.toBe(0);
  }
  // The row says how many threads it holds beyond the chips that fit.
  await expect(bundleRow(page, TOY_BOX).textContent()).resolves.toMatch(/\+\d+$/);

  // An account's own Inbox bundles its repository too.
  await page
    .getByRole('region', { name: 'Work' })
    .getByRole('button', { name: /^Inbox/ })
    .click();
  await page.getByRole('heading', { level: 2, name: 'Inbox' }).waitFor();
  await bundleRow(page, PIXELS).waitFor();
  await expect(bundleRow(page, TOY_BOX).count()).resolves.toBe(0);

  await page.goto(new URL(`/?q=${encodeURIComponent('toy-box')}`, app.url).href);
  await threadRows(page, TOY_BOX).first().waitFor();
  await expect(bundleRow(page, TOY_BOX).count()).resolves.toBe(0);
  expect(await threadRows(page, TOY_BOX).count()).toBeGreaterThan(1);

  await page.goto(app.url);
  await page
    .getByRole('region', { name: 'Personal' })
    .getByRole('button', { name: /^Toy Box/ })
    .click();
  await page.getByRole('heading', { level: 2, name: 'Toy Box' }).waitFor();
  await threadRows(page, TOY_BOX).first().waitFor();
  await expect(bundleRow(page, TOY_BOX).count()).resolves.toBe(0);
}, 60_000);

test('a bundle opens its threads unread, and a thread opens under it, steps by J and links to GitHub', async () => {
  const page = await open(DESKTOP);
  const row = bundleRow(page, TOY_BOX);
  await row.click();
  await shows(page, TOY_BOX);
  // Opening a bundle reads none of it, however long it stays open. This proves no read comes in the
  // time the reader takes to read what it opens, and a little more for the row to show it.
  await page.waitForTimeout(DWELL_MS + 500);
  await expect(row.getByText('Unread', { exact: true }).count()).resolves.toBe(1);
  await expect(
    threadTitles(page).first().getByRole('img', { name: 'Unread' }).count(),
  ).resolves.toBe(1);

  // The newest thread's link is its repository's and its number's.
  const first = threadTitles(page).first();
  const [title = '', number] = (await first.textContent())!.split(' #');
  const link = reader(page).getByRole('link', { name: `Open #${number} on GitHub` });
  await expect(link.getAttribute('href')).resolves.toMatch(
    new RegExp(`^https://github\\.com/${TOY_BOX}/(pull|issues)/${number}$`),
  );

  await first.click();
  const place = page.getByRole('toolbar', { name: 'Conversation' });
  await place.getByText(/^1 of \d+$/).waitFor();
  await shows(page, title);
  const threads = Number(/of (\d+)/.exec((await place.textContent())!)![1]);
  expect(threads).toBeGreaterThan(50);
  // The thread reaches the address once the selection has rested, and J's step would take its place.
  const newest = await openedOnceRested(page);
  await page.keyboard.press('j');
  await place.getByText(`2 of ${threads}`).waitFor();
  const second = (await (
    await page.waitForFunction((title) => {
      const shown = document.querySelector('section[aria-label="Reader"] h1')?.textContent;
      return shown && shown !== title ? shown : undefined;
    }, title)
  ).jsonValue()) as string;

  // The address keeps the bundle and its thread, and the crumb steps back to the bundle.
  await openedOnceRested(page, newest);
  expect(new URL(page.url()).searchParams.has('bundle')).toBe(true);
  await page.reload();
  await place.getByText(`2 of ${threads}`).waitFor();
  await shows(page, second);
  await reader(page).getByRole('button', { name: TOY_BOX, exact: true }).click();
  await shows(page, TOY_BOX);
}, 60_000);

test('a thread deep in its bundle opens at its place on a reload, and J moves on from it', async () => {
  const page = await open(DESKTOP);
  await bundleRow(page, TOY_BOX).click();
  await shows(page, TOY_BOX);
  // The bundle's sheet scrolls past its first page to the 56th thread.
  await reader(page)
    .locator('[data-index="1"]')
    .evaluate((sheet) => {
      let scroller = sheet.parentElement;
      while (scroller && !/auto|scroll/.test(getComputedStyle(scroller).overflowY)) {
        scroller = scroller.parentElement;
      }
      scroller!.scrollTop = 120 * 55;
    });
  const deep = reader(page).locator('[data-index="56"] article > div > button');
  const [title = ''] = (await deep.textContent())!.split(' #');
  await deep.click();
  const place = page.getByRole('toolbar', { name: 'Conversation' });
  await place.getByText(/^56 of \d+$/).waitFor();
  const threads = Number(/of (\d+)/.exec((await place.textContent())!)![1]);
  await openedOnceRested(page);
  const address = page.url();

  await page.reload();
  await place.getByText(`56 of ${threads}`).waitFor();
  await shows(page, title);
  await page.keyboard.press('j');
  await place.getByText(`57 of ${threads}`).waitFor();

  // Closing it before the page holding it arrives waits for that page, and the bundle opens with
  // the thread in sight rather than at its top.
  const early = await (await app.context(DESKTOP)).newPage();
  early.on('pageerror', (error) => errors.push(error.message));
  let release = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  let asked = 0;
  await early.route('**/_serverFn/**', async (route) => {
    if (decodeURIComponent(route.request().url()).includes('"around"')) {
      asked += 1;
      await held;
    }
    await route.fallback();
  });
  await early.goto(address);
  await shows(early, title);
  await reader(early).getByRole('button', { name: TOY_BOX, exact: true }).click();
  await shows(early, TOY_BOX);
  await reader(early).getByRole('status').filter({ hasText: 'Opening the repository' }).waitFor();
  await expect(reader(early).locator('[data-index]').count()).resolves.toBe(0);
  expect(asked).toBeGreaterThan(0);
  release();
  await early.unrouteAll({ behavior: 'wait' });
  const sheet = reader(early).locator('[data-index="56"]');
  await sheet.waitFor();
  const [came, sight] = await Promise.all([sheet.boundingBox(), reader(early).boundingBox()]);
  expect(came!.y).toBeGreaterThanOrEqual(sight!.y);
  expect(came!.y + came!.height).toBeLessThanOrEqual(sight!.y + sight!.height);
}, 60_000);

test("a bundle's actions act on every thread in it, and Undo brings them all back", async () => {
  const page = await open(DESKTOP);
  const row = bundleRow(page, TOY_BOX);
  await row.click();
  await shows(page, TOY_BOX);

  // Shift+I reads every thread, and Undo leaves them unread again.
  await page.keyboard.press('Shift+I');
  await row.getByText('Unread', { exact: true }).waitFor({ state: 'detached' });
  await expect(
    threadTitles(page).first().getByRole('img', { name: 'Unread' }).count(),
  ).resolves.toBe(0);
  await undoButton(page).click();
  await row.getByText('Unread', { exact: true }).waitFor();

  await page
    .getByRole('toolbar', { name: 'Repository' })
    .getByRole('button', { name: 'Archive' })
    .click();
  await row.waitFor({ state: 'detached', timeout: 1_000 });
  // Archive lists what went, each thread a conversation of its own.
  await undoButton(page).click();
  await row.waitFor({ timeout: 5_000 });
  await page.reload();
  await mailIsIn(page);
  await expect(row.count()).resolves.toBe(1);
  await expect(threadRows(page, TOY_BOX).count()).resolves.toBe(0);
}, 60_000);

test('on a phone, a bundle opens as a sheet whose island archives it, and a thread steps back to it', async () => {
  const page = await open(PHONE);
  await bundleRow(page, TOY_BOX).click();
  await shows(page, TOY_BOX);
  const island = page.getByRole('toolbar', { name: 'Repository' });
  // Archive is the island's main action, at its far end.
  await expect(island.getByRole('button').last().textContent()).resolves.toBe('Archive');

  const [title = ''] = (await threadTitles(page).first().textContent())!.split(' #');
  await threadTitles(page).first().click();
  await shows(page, title);
  await page.getByRole('button', { name: 'Back to toy-box' }).click();
  await shows(page, TOY_BOX);
}, 60_000);
