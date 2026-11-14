import { expect } from 'bun:test';
import type { Page, Request } from 'playwright';
import { hold } from './helpers.ts';
import { expectUsable } from './usable.ts';
import { SIZES, suite } from './suite.ts';
import { mailIsIn } from '../mailIsIn.ts';

/**
 * Folders, end to end: the built app on workerd, changing the demo mailbox's folders. A change
 * shows at once, a name the folder can't take says why before anything is sent, and a delete the
 * server refuses comes back with its reason. A fresh member each run starts from the seeded folders.
 */

// A test that fails leaves a screenshot of each page and what it showed, for CI to keep.
const { test, open } = suite({
  vars: { DEV_MEMBER: `folders-${Date.now()}@trailmix.test` },
  scale: 2,
});

const personal = (page: Page) => page.getByRole('region', { name: 'Personal' });
const folderRow = (page: Page, name: string) =>
  personal(page).getByRole('button', { name: new RegExp(`^${name}( \\d+)?$`) });
/** A command, held so that what shows before it’s answered is the page’s own doing. */
const commands = (request: Request) => request.method() === 'POST';

test('folders are made, nested and renamed in place, in their own account, and show before the server answers', async () => {
  const page = await open({ ...SIZES.desktop, colorScheme: 'light' });
  // Work has a Receipts of its own, at the path Personal's will take.
  const work = page.getByRole('region', { name: 'Work' });
  const worksReceipts = work.getByRole('button', { name: /^Receipts( \d+)?$/ });
  await worksReceipts.waitFor();

  // A name the folder can't take says why, and nothing is sent.
  await page.getByRole('button', { name: 'More for Personal' }).click();
  await page.getByRole('menuitem', { name: 'New folder in Personal' }).click();
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
  await expectUsable(page, 'folders-desktop-light-name-problem');
  expect(sent.filter((body) => body.includes('createFolder'))).toEqual([]);

  // A new folder shows at once, while its command is still on its way.
  let held = await hold(page, commands);
  await field.fill('Receipts');
  await field.press('Enter');
  await folderRow(page, 'Receipts').waitFor({ timeout: 1_000 });
  await held.release();

  // Inside the folder in view, from the menu at the end of its row. An empty folder says so.
  await folderRow(page, 'Receipts').click();
  await page.getByText('Receipts is empty', { exact: true }).waitFor();
  const menu = personal(page).getByRole('button', { name: 'More for Receipts' });
  await menu.click();
  await page.getByRole('menuitem', { name: 'New folder in Receipts' }).click();
  await page.getByRole('textbox', { name: 'Name of the new folder in Receipts' }).fill('Japan');
  await page.keyboard.press('Enter');
  await folderRow(page, 'Japan').waitFor();

  // Renamed in place, from the same menu. Only Personal's Receipts takes the field, which keeps the
  // keys until the name is given. The view follows it, Japan goes along, and Work's stays.
  held = await hold(page, commands);
  await menu.click();
  await page.getByRole('menuitem', { name: 'Rename Receipts' }).click();
  const renaming = personal(page).getByRole('textbox', { name: 'New name for Receipts' });
  await expect(renaming.inputValue()).resolves.toBe('Receipts');
  await expect(renaming.evaluate((input) => input === document.activeElement)).resolves.toBe(true);
  await expect(work.getByRole('textbox').count()).resolves.toBe(0);
  await expectUsable(page, 'folders-desktop-light-renaming');
  await renaming.fill('Travel');
  await renaming.press('Enter');
  await folderRow(page, 'Travel').waitFor({ timeout: 1_000 });
  await page.getByRole('heading', { name: 'Travel', level: 2 }).waitFor({ timeout: 1_000 });
  await expect(folderRow(page, 'Receipts').count()).resolves.toBe(0);
  await held.release();
  await folderRow(page, 'Japan').waitFor();
  await worksReceipts.waitFor();
  // Once the server has it, a reload shows the same.
  await page.reload();
  await folderRow(page, 'Travel').waitFor({ timeout: 10_000 });
  await folderRow(page, 'Japan').waitFor();
}, 60_000);

test('a delete asks first with what goes, comes back with the server’s reason, then goes', async () => {
  const page = await open({ ...SIZES.desktop, colorScheme: 'dark' });
  await folderRow(page, 'Projects').click();
  // The list's folder menu gathers what can be done to the folder in view.
  await page.getByRole('button', { name: 'Folder', exact: true }).click();
  const items = page.getByRole('menuitem');
  await items.first().waitFor();
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
  await expectUsable(page, 'folders-desktop-dark-delete-question');

  // The demo's server turns the first delete away. The folder goes at once, and comes back.
  const held = await hold(page, commands);
  await question.getByRole('button', { name: 'Delete' }).click();
  await folderRow(page, 'Projects').waitFor({ state: 'detached', timeout: 1_000 });
  await expect(folderRow(page, 'Toy Box').count()).resolves.toBe(0);
  await held.release();
  await page
    .getByRole('region', { name: 'Notifications' })
    .getByText('Couldn’t delete Projects. NO [INUSE] Projects is open in another session.')
    .waitFor({ timeout: 10_000 });
  await folderRow(page, 'Projects').waitFor();
  await folderRow(page, 'Toy Box').waitFor();
  // The view went to the Inbox with the folder, and comes back with it.
  await page.getByRole('heading', { name: 'Projects', level: 2 }).waitFor();
  await expectUsable(page, 'folders-desktop-dark-refused');

  await page.getByRole('button', { name: 'Folder', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Delete Projects' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Delete' }).click();
  await page.getByRole('heading', { name: 'Inbox', level: 2 }).waitFor();
  await page.reload();
  await mailIsIn(page);
  await personal(page)
    .getByRole('button', { name: /^Inbox/ })
    .waitFor();
  await expect(folderRow(page, 'Projects').count()).resolves.toBe(0);
  await expect(folderRow(page, 'Toy Box').count()).resolves.toBe(0);
}, 60_000);

test('on a phone, a folder is named in the sidebar', async () => {
  const page = await open({ ...SIZES.phone, colorScheme: 'light' });
  await page.getByRole('button', { name: 'Folders', exact: true }).click();
  await folderRow(page, 'Archive').click();
  const folderMenu = page.getByRole('button', { name: 'Folder', exact: true });
  await folderMenu.waitFor();

  // From the list's folder menu, the sidebar comes into view with the field.
  await folderMenu.click();
  await page.getByRole('menuitem', { name: 'New folder in Archive' }).click();
  const field = page.getByRole('textbox', { name: 'Name of the new folder in Archive' });
  await field.waitFor();
  await expect(field.getAttribute('placeholder')).resolves.toBe('Folder name');
  await expect(field.evaluate((input) => !input.closest('[inert]'))).resolves.toBe(true);
  await expectUsable(page, 'folders-phone-light-naming');
  await field.fill('2026');
  await field.press('Enter');
  await folderRow(page, '2026').waitFor();
}, 60_000);
