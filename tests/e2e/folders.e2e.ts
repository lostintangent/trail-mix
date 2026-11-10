import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  chromium,
  type Browser,
  type BrowserContextOptions,
  type Page,
  type Route,
} from 'playwright';
import { unreadableText } from './contrast.ts';
import { startPreview, type Preview } from './preview.ts';

/**
 * Folders, end to end: the built app on workerd, changing the demo mailbox's folders. A change
 * shows at once, a name the folder can't take says why before anything is sent, and a delete the
 * server refuses comes back with its reason. A fresh member each run starts from the seeded folders.
 */

const SHOTS = join(import.meta.dir, '../../test-results');
const DESKTOP = { viewport: { width: 1440, height: 900 } };
const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true };

let preview: Preview;
let browser: Browser;

beforeAll(async () => {
  mkdirSync(SHOTS, { recursive: true });
  preview = await startPreview({ DEV_MEMBER: `folders-${Date.now()}@trailmix.test` });
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

async function open(options: BrowserContextOptions): Promise<Page> {
  const page = await (await browser.newContext({ deviceScaleFactor: 2, ...options })).newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(preview.url);
  await page.getByText('Up to date').waitFor({ state: 'attached', timeout: 30_000 });
  return page;
}

const personal = (page: Page) => page.getByRole('region', { name: 'Personal' });
const folderRow = (page: Page, name: string) =>
  personal(page).getByRole('button', { name: new RegExp(`^${name}( \\d+)?$`) });

/** Holds every command this page sends until released, so what shows before is its own doing. */
async function holdCommands(page: Page): Promise<() => Promise<void>> {
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  const hold = async (route: Route) => {
    if (route.request().method() === 'POST') await released;
    await route.continue().catch(() => {});
  };
  await page.route('**/_serverFn/**', hold);
  return async () => {
    release();
    await page.unroute('**/_serverFn/**', hold);
  };
}

async function readable(page: Page, screen: string) {
  await page.screenshot({ path: join(SHOTS, `folders-${screen}.png`) });
  expect({ screen, unreadable: await unreadableText(page) }).toEqual({ screen, unreadable: [] });
}

test('folders are made, nested and renamed in place, and show before the server answers', async () => {
  const page = await open({ ...DESKTOP, colorScheme: 'light' });

  // A name the folder can't take says why, and nothing is sent.
  await page.getByRole('button', { name: 'New folder in Personal' }).click();
  const field = page.getByRole('textbox', { name: 'Name of the new folder in Personal' });
  const sent: string[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST') sent.push(request.postData() ?? '');
  });
  await field.fill('archive');
  await field.press('Enter');
  await page
    .getByRole('alert')
    .filter({ hasText: 'There’s already a folder called “archive” here.' })
    .waitFor();
  await readable(page, 'desktop-light-name-problem');
  expect(sent.filter((body) => body.includes('createFolder'))).toEqual([]);

  // A new folder shows at once, while its command is still on its way.
  let release = await holdCommands(page);
  await field.fill('Trips');
  await field.press('Enter');
  await folderRow(page, 'Trips').waitFor({ timeout: 1_000 });
  await release();

  // Inside the folder in view, from the menu at the end of its row.
  await folderRow(page, 'Trips').click();
  await page.getByRole('button', { name: 'More for this folder' }).click();
  await page.getByRole('menuitem', { name: 'New folder in Trips' }).click();
  await page.getByRole('textbox', { name: 'Name of the new folder in Trips' }).fill('Japan');
  await page.keyboard.press('Enter');
  await folderRow(page, 'Japan').waitFor();

  // Renamed in place, from the list's folder menu. The view follows it, and Japan goes along.
  release = await holdCommands(page);
  await page.getByRole('button', { name: 'Folder', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Rename Trips' }).click();
  const renaming = page.getByRole('textbox', { name: 'New name for Trips' });
  await expect(renaming.inputValue()).resolves.toBe('Trips');
  await readable(page, 'desktop-light-renaming');
  await renaming.fill('Travel');
  await renaming.press('Enter');
  await folderRow(page, 'Travel').waitFor({ timeout: 1_000 });
  await page.getByRole('heading', { name: 'Travel', level: 2 }).waitFor({ timeout: 1_000 });
  await expect(folderRow(page, 'Trips').count()).resolves.toBe(0);
  await release();
  await folderRow(page, 'Japan').waitFor();
  // Once the server has it, a reload shows the same.
  await page.reload();
  await folderRow(page, 'Travel').waitFor({ timeout: 10_000 });
  await folderRow(page, 'Japan').waitFor();
}, 60_000);

test('a delete asks first with what goes, comes back with the server’s reason, then goes', async () => {
  const page = await open({ ...DESKTOP, colorScheme: 'dark' });
  await folderRow(page, 'Projects').click();
  // The list's folder menu gathers what can be done to the folder in view.
  await page.getByRole('button', { name: 'Folder', exact: true }).click();
  const items = page.getByRole('menuitem');
  await expect(items.allTextContents()).resolves.toEqual([
    'New folder in Projects',
    'Rename Projects',
    'Delete Projects',
  ]);
  await items.filter({ hasText: 'Delete Projects' }).click();
  const question = page.getByRole('alertdialog');
  await question
    .getByText(
      /^Projects, with 1 folder inside it and \d+ messages, will be deleted from the mail server\. This can’t be undone\.$/,
    )
    .waitFor();
  await readable(page, 'desktop-dark-delete-question');

  // The demo's server turns the first delete away. The folder goes at once, and comes back.
  const release = await holdCommands(page);
  await question.getByRole('button', { name: 'Delete' }).click();
  await folderRow(page, 'Projects').waitFor({ state: 'detached', timeout: 1_000 });
  await expect(folderRow(page, 'Toy Box').count()).resolves.toBe(0);
  await release();
  await page
    .getByRole('region', { name: 'Notifications' })
    .getByText('Couldn’t delete Projects. NO [INUSE] Projects is open in another session.')
    .waitFor({ timeout: 10_000 });
  await folderRow(page, 'Projects').waitFor();
  await folderRow(page, 'Toy Box').waitFor();
  // The view went to the Inbox with the folder, and comes back with it.
  await page.getByRole('heading', { name: 'Projects', level: 2 }).waitFor();
  await readable(page, 'desktop-dark-refused');

  await page.getByRole('button', { name: 'Folder', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Delete Projects' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Delete' }).click();
  await page.getByRole('heading', { name: 'Inbox', level: 2 }).waitFor();
  await page.reload();
  await page.getByText('Up to date').waitFor({ state: 'attached', timeout: 30_000 });
  await personal(page)
    .getByRole('button', { name: /^Inbox/ })
    .waitFor();
  await expect(folderRow(page, 'Projects').count()).resolves.toBe(0);
  await expect(folderRow(page, 'Toy Box').count()).resolves.toBe(0);
}, 60_000);

test('on a phone, folder controls are 44 pixels, and a folder is named in the sidebar', async () => {
  const page = await open({ ...PHONE, colorScheme: 'light' });
  await page.getByRole('button', { name: 'Folders', exact: true }).click();
  const add = page.getByRole('button', { name: 'New folder in Work' });
  await folderRow(page, 'Archive').click();
  const header = page.getByRole('button', { name: 'Folder', exact: true });
  await header.waitFor();

  // From the list's menu, the sidebar comes into view with the field.
  await header.click();
  await page.getByRole('menuitem', { name: 'New folder in Archive' }).click();
  const field = page.getByRole('textbox', { name: 'Name of the new folder in Archive' });
  await field.waitFor();
  await expect(field.evaluate((input) => !input.closest('[inert]'))).resolves.toBe(true);
  for (const control of [add, page.getByRole('button', { name: 'More for this folder' }), field]) {
    const box = (await control.boundingBox())!;
    expect(Math.min(box.width, box.height)).toBeGreaterThanOrEqual(44);
  }
  await readable(page, 'phone-light-naming');
  await field.fill('2026');
  await field.press('Enter');
  await folderRow(page, '2026').waitFor();
}, 60_000);
