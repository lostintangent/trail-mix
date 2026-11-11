import { afterEach, expect } from 'bun:test';
import type { BrowserContextOptions, Page } from 'playwright';
import { suite } from './suite.ts';

/**
 * The address, end to end: the built app on workerd, on a member of its own. The address names the
 * view, the search and the open conversation, so a reload or another browser opens the same place,
 * Back and Forward step between views, and moving by key adds no history.
 */

const DESKTOP = { viewport: { width: 1440, height: 900 } };
const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true };

const app = suite({ vars: { DEV_MEMBER: `address-${Date.now()}@trailmix.test` } });
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
  await page.getByRole('option').first().waitFor({ timeout: 30_000 });
  return page;
}

const heading = (page: Page) =>
  page.getByRole('heading', { level: 2 }).filter({ hasNotText: /^(Personal|Work)$/ });
const subject = (page: Page) => page.locator('section[aria-label="Reader"] h1');
const selectedRow = (page: Page) => page.locator('[role="option"][aria-selected="true"]');
const historyLength = (page: Page) => page.evaluate(() => history.length);
/** The address once the selection has rested and written it. */
const addressNaming = (page: Page, key: string) =>
  page.waitForFunction((key) => new URL(location.href).searchParams.has(key), key);

test('a folder and its open conversation come back on a reload and in another browser', async () => {
  const page = await open(DESKTOP);
  await page
    .getByRole('region', { name: 'Personal' })
    .getByRole('button', { name: /^Archive/ })
    .click();
  await heading(page).filter({ hasText: 'Archive' }).waitFor();
  await page.getByRole('option').nth(1).click();
  const shown = await subject(page).textContent();
  await addressNaming(page, 'open');
  const address = page.url();
  expect(new URL(address).searchParams.get('folder')).toBe('Archive');

  for (const again of [page, await (await app.context(DESKTOP)).newPage()]) {
    await (again === page ? again.reload() : again.goto(address));
    await heading(again).filter({ hasText: 'Archive' }).waitFor();
    await expect(subject(again).textContent()).resolves.toBe(shown);
    await expect(selectedRow(again).textContent()).resolves.toContain(shown!.replace(/^Re: /, ''));
  }
}, 60_000);

test('Back and Forward step between views, and moving by key adds no history', async () => {
  const page = await open(DESKTOP);
  const sidebar = page.getByRole('navigation', { name: 'Mailboxes' });
  await page.getByRole('option').nth(0).click();
  await addressNaming(page, 'open');
  const first = new URL(page.url()).searchParams.get('open');
  const before = await historyLength(page);
  for (let press = 0; press < 5; press++) await page.keyboard.press('j');
  // Once the keys rest, the address names the sixth conversation, which the reader shows.
  await page.waitForFunction((first) => {
    const open = new URL(location.href).searchParams.get('open');
    const row = document.querySelector('[role="option"][aria-selected="true"]');
    const shown = document.querySelector('section[aria-label="Reader"] h1')?.textContent;
    return (
      open !== first &&
      row?.getAttribute('aria-posinset') === '6' &&
      Boolean(shown && row.textContent?.includes(shown.replace(/^Re: /, '')))
    );
  }, first);
  expect(await historyLength(page)).toBe(before);

  await sidebar
    .getByRole('button', { name: /^Drafts/ })
    .first()
    .click();
  await heading(page).filter({ hasText: 'Drafts' }).waitFor();
  await sidebar
    .getByRole('button', { name: /^Flagged/ })
    .first()
    .click();
  await heading(page).filter({ hasText: 'Flagged' }).waitFor();
  await page.goBack();
  await heading(page).filter({ hasText: 'Drafts' }).waitFor();
  await page.goBack();
  await heading(page).filter({ hasText: 'Inbox' }).waitFor();
  await page.goForward();
  await heading(page).filter({ hasText: 'Drafts' }).waitFor();

  // A search typed is one step back, however many keys it took, and a reload keeps it.
  await page.getByRole('searchbox', { name: 'Search mail' }).pressSequentially('lunch thu');
  await page.locator('[role="option"] mark').first().waitFor();
  // Once the typing rests, the address holds the whole search.
  await page.waitForFunction(() => new URL(location.href).searchParams.get('q') === 'lunch thu');
  await page.reload();
  await expect(page.getByRole('searchbox', { name: 'Search mail' }).inputValue()).resolves.toBe(
    'lunch thu',
  );
  await page.locator('[role="option"] mark').first().waitFor();
  await page.goBack();
  await heading(page).filter({ hasText: 'Drafts' }).waitFor();

  // A key's move made just before the view changes is in the step Back returns to.
  await sidebar
    .getByRole('button', { name: /^Inbox/ })
    .first()
    .click();
  await heading(page).filter({ hasText: 'Inbox' }).waitFor();
  await page.getByRole('option').nth(0).click();
  await page.keyboard.press('j');
  await sidebar
    .getByRole('button', { name: /^Flagged/ })
    .first()
    .click();
  await heading(page).filter({ hasText: 'Flagged' }).waitFor();
  await page.goBack();
  await heading(page).filter({ hasText: 'Inbox' }).waitFor();
  await expect(selectedRow(page).getAttribute('aria-posinset')).resolves.toBe('2');
}, 60_000);

test('an address whose conversation or folder has gone opens what remains, and says so', async () => {
  const page = await open(DESKTOP);
  await page.getByRole('option').nth(1).click();
  await addressNaming(page, 'open');
  const opened = new URL(page.url()).searchParams.get('open')!;
  const gone = new URL(page.url());
  gone.searchParams.set('in', 'flagged');
  gone.searchParams.set('open', opened.replace(/:[^:]*$/, ':%3Cgone%40example.com%3E'));
  await page.goto(gone.href);
  await heading(page).filter({ hasText: 'Flagged' }).waitFor();
  await page.waitForFunction(() => location.search === '?in=flagged');
  await expect(selectedRow(page).count()).resolves.toBe(0);

  await page.goto(new URL('/?account=gone&folder=Nowhere', app.url).href);
  await heading(page).filter({ hasText: 'Inbox' }).waitFor();
  await page.waitForFunction(() => location.search === '');
}, 60_000);

test('on a phone, a conversation opens on its own address, Back slides to the list, and a reload opens it again with no slide', async () => {
  const page = await open(PHONE);
  const reader = page.locator('section[aria-label="Reader"]');
  const isShown = () => reader.evaluate((element) => !element.closest('[inert]'));
  const before = await historyLength(page);
  await page.getByRole('option').nth(1).click();
  await subject(page).waitFor();
  await expect(historyLength(page)).resolves.toBe(before + 1);
  const address = page.url();
  await page.goBack();
  await page.waitForFunction(() => location.search === '');
  await expect(isShown()).resolves.toBe(false);

  // From the first frame the reader holds the screen, with no slide to it.
  await page.addInitScript(() => {
    const first: string[] = [];
    Object.assign(window, { firstReader: first });
    new MutationObserver(() => {
      const reader = document.querySelector('section[aria-label="Reader"]');
      if (reader && first.length === 0) first.push(reader.closest('[inert]') ? 'away' : 'shown');
    }).observe(document, { childList: true, subtree: true });
  });
  await page.goto(address);
  await subject(page).waitFor();
  expect(
    await page.evaluate(() => (window as unknown as { firstReader: string[] }).firstReader),
  ).toEqual(['shown']);
  // Back in the app, with nothing pushed in this visit, takes the conversation out of the address.
  await page.getByRole('button', { name: 'Back', exact: true }).locator('visible=true').click();
  await page.waitForFunction(() => location.search === '');
  await expect(isShown()).resolves.toBe(false);
}, 60_000);
