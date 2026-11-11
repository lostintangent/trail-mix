import { afterEach, beforeAll, expect } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { BrowserContextOptions, Page } from 'playwright';
import { unreadableText } from './contrast.ts';
import { suite } from './suite.ts';
import { mailIsIn } from '../mailIsIn.ts';
import { atRest } from '../atRest.ts';

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
  await mailIsIn(page);
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
  const gear = sidebar.getByRole('button', { name: 'Open settings' });
  const at = await fold.boundingBox();
  const gearAt = await gear.boundingBox();
  await fold.click();
  await page.waitForFunction(
    () =>
      getComputedStyle(document.documentElement).getPropertyValue('--workbench-sidebar') === '50px',
  );
  // The fold button at the top and the gear at the foot hold still across the fold, and the search
  // moves above the list.
  expect(await unfold.boundingBox()).toEqual(at);
  expect(await gear.boundingBox()).toEqual(gearAt);
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
    'Open settings',
  ]) {
    await sidebar.getByRole('button', { name }).waitFor({ timeout: 1_000 });
  }
  // An account's stamp opens its Inbox.
  await atRest(page);
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

test('the foot holds the Settings gear, a rule and Trail Mix, and says nothing about the mail', async () => {
  for (const [size, options] of [
    ['desktop', DESKTOP],
    ['phone', PHONE],
  ] as const) {
    for (const colorScheme of ['light', 'dark'] as const) {
      const page = await open({ ...options, colorScheme });
      if (size === 'phone')
        await page.getByRole('button', { name: 'Folders', exact: true }).click();
      await atRest(page);
      const sidebar = page.getByRole('navigation', { name: 'Mailboxes' });
      const name = sidebar.getByText('Trail Mix', { exact: true });
      const gear = sidebar.getByRole('button', { name: 'Open settings' });
      // The gear, then the name, side by side at the very foot, and nothing below or after them.
      const [nameBox, gearBox, sidebarBox] = await Promise.all([
        name.boundingBox(),
        gear.boundingBox(),
        sidebar.boundingBox(),
      ]);
      expect(
        Math.abs(nameBox!.y + nameBox!.height / 2 - (gearBox!.y + gearBox!.height / 2)),
      ).toBeLessThan(2);
      expect(gearBox!.x).toBeLessThan(nameBox!.x);
      expect(sidebarBox!.y + sidebarBox!.height - (gearBox!.y + gearBox!.height)).toBeLessThan(40);
      const atFoot = {
        size,
        colorScheme,
        controls: await sidebar.evaluate(
          (nav, below) =>
            [...nav.querySelectorAll('button, input')]
              .filter((control) => {
                const { top, left, width, height } = control.getBoundingClientRect();
                // What the tree scrolls out of sight lies below too, under the foot.
                const seen = document.elementFromPoint(left + width / 2, top + height / 2);
                return top >= below && !!seen && control.contains(seen);
              })
              .map((control) => control.getAttribute('aria-label') ?? control.textContent),
          gearBox!.y - 1,
        ),
      };
      expect(atFoot).toEqual({ size, colorScheme, controls: ['Open settings'] });
      expect((await sidebar.getByRole('status').allTextContents()).join('')).toBe('');
      expect(await page.getByText(/Up to date|Checking for mail/).count()).toBe(0);
      if (size === 'phone') {
        expect(Math.min(gearBox!.width, gearBox!.height)).toBeGreaterThanOrEqual(44);
      }
      await readable(page, `${size}-${colorScheme}-foot`);
      if (size === 'desktop') {
        // Folded, the rail keeps the gear where it was, alone at its foot.
        await page.keyboard.press('ControlOrMeta+b');
        await sidebar.getByRole('button', { name: 'Unfold the sidebar' }).waitFor();
        await atRest(page);
        expect(await gear.boundingBox()).toEqual(gearBox);
        await readable(page, `${size}-${colorScheme}-rail-foot`);
        await page.keyboard.press('ControlOrMeta+b');
        await sidebar.getByRole('button', { name: 'Fold the sidebar' }).waitFor();
      }

      // The gear opens Settings in the reader's place.
      await gear.click();
      await page
        .getByRole('region', { name: 'Reader' })
        .getByRole('heading', { name: 'Settings', level: 1 })
        .waitFor();
      await atRest(page);
      if (size === 'phone') {
        const swatch = await page.getByLabel('Accent color').evaluate((input) => {
          const { width, height } = input.getBoundingClientRect();
          return Math.min(width, height);
        });
        expect(swatch).toBeGreaterThanOrEqual(44);
      }
      await readable(page, `${size}-${colorScheme}-settings`);

      // A Tab onto the swatch rings the color, whole, within what Settings shows.
      const picker = page.getByLabel('Accent color');
      await picker.focus();
      await page.keyboard.press('Shift+Tab');
      await page.keyboard.press('Tab');
      const settings = await page.getByRole('region', { name: 'Settings' }).elementHandle();
      expect(
        await picker.evaluate((input, shown) => {
          const swatch = input.nextElementSibling!;
          const { outlineStyle, outlineWidth, outlineOffset } = getComputedStyle(swatch);
          const reach = parseFloat(outlineWidth) + parseFloat(outlineOffset);
          const ring = swatch.getBoundingClientRect();
          const within = shown.getBoundingClientRect();
          return {
            isFocusVisible: input.matches(':focus-visible'),
            ring: `${outlineStyle} ${outlineWidth}`,
            isWhole:
              ring.left - reach >= within.left &&
              ring.right + reach <= Math.min(within.right, innerWidth) &&
              ring.top - reach >= within.top &&
              ring.bottom + reach <= within.bottom,
          };
        }, settings),
      ).toEqual({ isFocusVisible: true, ring: 'solid 2px', isWhole: true });
      await readable(page, `${size}-${colorScheme}-swatch-focus`);
      await page.context().close();
    }
  }
}, 90_000);

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

test('the tree is one Tab stop, whose arrows move through it and fold it, and whose rows open their menus by key', async () => {
  const page = await open({ ...DESKTOP, colorScheme: 'light' });
  await page
    .getByRole('region', { name: 'Work' })
    .getByRole('button', { name: /^Receipts/ })
    .waitFor();
  // What has focus, by role and name, leaving out any count after a row's name.
  const focused = () =>
    page.evaluate(() => {
      const element = document.activeElement!;
      const name = element.getAttribute('aria-label') ?? element.textContent.replace(/\d+$/, '');
      return `${element.getAttribute('role') ?? element.tagName}: ${name}`;
    });
  // Focus moves a moment after a key: the tree's moves load as it first takes focus, and a menu
  // moves focus once it has opened or closed.
  const focusIs = async (to: string) => {
    for (let wait = 0; wait < 100 && (await focused()) !== to; wait++) {
      await page.waitForTimeout(20);
    }
    expect(await focused()).toBe(to);
  };
  const moveTo = async (key: string, to: string) => {
    await page.keyboard.press(key);
    await focusIs(to);
  };
  const downTo = async (to: string) => {
    for (let line = 0; line < 30 && (await focused()) !== to; line++) {
      const from = await focused();
      await page.keyboard.press('ArrowDown');
      for (let wait = 0; wait < 100 && (await focused()) === from; wait++) {
        await page.waitForTimeout(20);
      }
    }
    expect(await focused()).toBe(to);
  };
  const ring = () =>
    page.evaluate(() => {
      const { outlineStyle, outlineWidth, outlineColor } = getComputedStyle(
        document.activeElement!,
      );
      return `${outlineStyle} ${outlineWidth} ${outlineColor}`;
    });

  // The fold button leads, and the tree is one stop between the search and Add account, entered on
  // the view's line.
  await moveTo('Tab', 'BUTTON: Fold the sidebar');
  const astryx = await ring();
  const stops = [];
  for (let stop = 0; stop < 4; stop++) {
    await page.keyboard.press('Tab');
    stops.push(await focused());
  }
  expect(stops).toEqual([
    'BUTTON: New message',
    'INPUT: Search mail',
    'BUTTON: Inbox',
    'BUTTON: Add account',
  ]);

  // The arrows step through the lines, into an account and back out of it, and reach either end.
  await moveTo('Shift+Tab', 'BUTTON: Inbox');
  await moveTo('ArrowDown', 'BUTTON: Flagged');
  await moveTo('End', 'BUTTON: Trash');
  await moveTo('Home', 'BUTTON: Inbox');
  await page.keyboard.press('ArrowUp');
  await moveTo('ArrowDown', 'BUTTON: Flagged');
  await downTo('BUTTON: Personal');
  await moveTo('ArrowRight', 'BUTTON: Inbox');
  await moveTo('ArrowLeft', 'BUTTON: Personal');
  // Every line it reaches draws the focus ring every Astryx control does.
  expect(await ring()).toBe(astryx);

  // Right steps into a folder and left steps out, then folds it and unfolds it again.
  await downTo('BUTTON: Projects');
  expect(await ring()).toBe(astryx);
  await moveTo('ArrowRight', 'BUTTON: Toy Box');
  await moveTo('ArrowLeft', 'BUTTON: Projects');
  await page.keyboard.press('ArrowLeft');
  await folderRow(page, 'Toy Box').waitFor({ state: 'detached' });
  await page.keyboard.press('ArrowRight');
  await folderRow(page, 'Toy Box').waitFor();
  await focusIs('BUTTON: Projects');

  // Enter opens a folder, and the tree is entered on it from then on.
  await page.keyboard.press('Enter');
  await page.getByRole('heading', { name: 'Projects', level: 2 }).waitFor();
  await moveTo('ArrowUp', 'BUTTON: Drafts');
  await page.keyboard.press('Tab');
  await moveTo('Shift+Tab', 'BUTTON: Projects');

  // Shift+F10 opens a row's menu, which loads as it's first opened, and Escape comes back to the row.
  await downTo('BUTTON: Receipts');
  await moveTo('Shift+F10', 'menuitem: New folder in Receipts');
  await moveTo('ArrowDown', 'menuitem: Rename Receipts');
  await moveTo('Escape', 'BUTTON: Receipts');
  await moveTo('ArrowDown', 'BUTTON: Junk');

  // A right click opens a row's menu too.
  await folderRow(page, 'Projects').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'New folder in Projects' }).waitFor();
  await page.keyboard.press('Escape');

  // A search lifts no line, so the tree is entered on its first.
  await page.getByRole('searchbox', { name: 'Search mail' }).fill('lunch');
  await page.waitForFunction(() => new URL(location.href).searchParams.get('q') === 'lunch');
  await moveTo('Tab', 'BUTTON: Clear search');
  await moveTo('Tab', 'BUTTON: Inbox');
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
  await mailIsIn(page);
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
