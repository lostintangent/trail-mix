import { expect } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { BrowserContextOptions, Page } from 'playwright';
import { ICONS } from '../../src/app/icons.ts';
import { suite } from './suite.ts';

const SHOTS = join(import.meta.dir, '../../test-results');
mkdirSync(SHOTS, { recursive: true });

/**
 * Installing Trail Mix: Chromium finds nothing that stops it, and the manifest and icons it asks
 * for arrive with the member's cookie, since Cloudflare Access answers a request without it with
 * its sign-in page.
 */

const app = suite();
const { test } = app;

const SIZES = {
  desktop: { viewport: { width: 1440, height: 900 } },
  phone: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
} satisfies Record<string, BrowserContextOptions>;
const THEMES = ['light', 'dark'] as const;
/** A conversation far enough down the Inbox that opening the first never prepares it ahead. */
const NEVER_OPENED = /Trip photos/;

test('Chromium can install Trail Mix, and asks for its manifest with the member’s cookie', async () => {
  const context = await app.context();
  await context.addCookies([{ name: 'CF_Authorization', value: 'member', url: app.url }]);
  const page = await context.newPage();
  const asked = page.waitForRequest(/\/manifest\.webmanifest$/);
  await page.goto(app.url, { waitUntil: 'networkidle' });
  const browser = await context.newCDPSession(page);

  const { errors } = await browser.send('Page.getAppManifest');
  const { installabilityErrors } = await browser.send('Page.getInstallabilityErrors');
  expect({ errors, installabilityErrors }).toEqual({ errors: [], installabilityErrors: [] });
  expect((await (await asked).allHeaders())['cookie']).toContain('CF_Authorization=member');
  await context.close();
});

test('every icon is a PNG at its size, the touch icon included', async () => {
  const context = await app.context();
  const page = await context.newPage();
  await page.goto(app.url, { waitUntil: 'load' });
  const touch = await page.locator('link[rel="apple-touch-icon"]').getAttribute('href');
  expect(touch).toBe('/icons/apple-touch-icon.png');
  for (const { file, size } of ICONS) {
    const response = await page.request.get(new URL(`/icons/${file}`, app.url).href);
    const header = new DataView((await response.body()).buffer);
    expect({
      file,
      type: response.headers()['content-type'],
      width: header.getUint32(16),
      height: header.getUint32(20),
    }).toEqual({ file, type: 'image/png', width: size, height: size });
  }
  await context.close();
});

test('the installed app with nothing kept opens offline, and says it can’t reach the mail', async () => {
  const { context, page } = await installed();
  await page.evaluate(() => keptNothing());

  await context.setOffline(true);
  await page.reload();
  // The shell and the app's code came from the worker, so the app runs and says what it can't do.
  await page
    .getByRole('heading', { name: 'Trail Mix can’t reach your mail' })
    .waitFor({ timeout: 15_000 });
  await context.close();
}, 45_000);

test('the installed app opens offline to the lists and conversations it showed', async () => {
  const { context, page } = await installed();
  const subjects: string[] = [];
  for (const row of [0, 1, 2]) subjects.push(await openConversation(page, row));
  // Each conversation and its open body is kept as it arrives.
  await page.waitForFunction(async (least) => (await keptCount()) >= least, 9, { polling: 200 });

  await context.setOffline(true);
  await page.reload();
  const status = page.getByText('Offline: kept mail');
  await status.waitFor();
  // The sidebar at its first width says all of it.
  expect(await status.evaluate((line) => line.scrollWidth <= line.clientWidth)).toBe(true);
  await page.screenshot({ path: join(SHOTS, 'desktop-light-offline.png') });
  for (const [row, subject] of subjects.entries()) {
    expect({ row, opened: await openConversation(page, row) }).toEqual({ row, opened: subject });
  }
  await context.close();
}, 60_000);

test('the installed app reads offline at both sizes in both themes: the Inbox and what it opened', async () => {
  for (const [size, options] of Object.entries(SIZES)) {
    for (const colorScheme of THEMES) {
      const { context, page, errors } = await installed({ ...options, colorScheme });
      const subject = await openConversation(page, 0);
      await page.waitForFunction(async () => (await keptCount()) >= 3, undefined, { polling: 200 });

      await context.setOffline(true);
      await page.reload();
      // The address names the conversation, which opens from what the device kept, beside the
      // Inbox, or on a phone over it.
      await page.getByText('Offline: kept mail').first().waitFor({ state: 'attached' });
      await page.waitForFunction(
        (subject) =>
          document.querySelector('section[aria-label="Reader"] h1')?.textContent === subject &&
          document.querySelector('section[aria-label="Reader"] article') !== null,
        subject,
      );
      await page.screenshot({ path: join(SHOTS, `offline-${size}-${colorScheme}.png`) });
      if (size === 'phone') {
        await page.getByRole('button', { name: 'Back', exact: true }).click();
        await page.getByRole('option').first().waitFor();
        // The sidebar that says it on a desktop is off the screen, so the list says it.
        await page
          .getByRole('region', { name: 'Inbox' })
          .getByRole('status')
          .filter({ hasText: 'Offline: kept mail' })
          .waitFor();
        await page.waitForTimeout(400);
        await page.screenshot({ path: join(SHOTS, `offline-phone-${colorScheme}-inbox.png`) });
      }
      expect({ size, colorScheme, rows: (await page.getByRole('option').count()) > 5 }).toEqual({
        size,
        colorScheme,
        rows: true,
      });
      expect({ size, colorScheme, errors }).toEqual({ size, colorScheme, errors: [] });
      await context.close();
    }
  }
}, 120_000);

test('offline, a conversation never opened says it opens once online, and Send keeps the message', async () => {
  const { context, page, errors } = await installed();
  await openConversation(page, 0);
  await page.waitForFunction(async () => (await keptCount()) >= 3, undefined, { polling: 200 });
  await context.setOffline(true);
  await page.reload();
  await page.getByText('Offline: kept mail').waitFor();

  // Its subject is the list's, and the reader says why the rest can't come, never that nothing
  // is open.
  await page.getByRole('option').filter({ hasText: NEVER_OPENED }).first().click();
  const reader = page.locator('section[aria-label="Reader"]');
  await reader.getByRole('alert').filter({ hasText: 'It opens once you’re back online' }).waitFor();
  expect(await reader.locator('h1').textContent()).toMatch(NEVER_OPENED);
  await page.screenshot({ path: join(SHOTS, 'offline-desktop-light-unopened.png') });

  // Archive can't reach the mail server, so the row stays, and the toast says why in plain words.
  await page.keyboard.press('e');
  await page
    .getByText(/^Couldn.t archive\. This device is offline\.$/)
    .first()
    .waitFor();
  expect(await page.getByRole('option').filter({ hasText: NEVER_OPENED }).count()).toBe(1);
  // The selection moved on as the row left, and the conversation it moved to says it isn't here
  // either, rather than standing as a skeleton while the page asks again.
  await reader.getByRole('alert').filter({ hasText: 'It opens once you’re back online' }).waitFor();
  await page.screenshot({ path: join(SHOTS, 'offline-desktop-light-archive.png') });

  // Writing offline is out of scope, so Send and Send later wait, plainly, and say why, and what was
  // written stays.
  await page.keyboard.press('c');
  const composer = page.getByRole('region', { name: 'New message' });
  await composer.getByRole('textbox', { name: 'To' }).fill('sam@trailmix.test');
  await composer.getByRole('textbox', { name: 'Subject' }).fill('Written offline');
  const message = composer.getByRole('textbox', { name: 'Message' });
  await message.fill('Kept until the network is back.');
  await composer
    .getByRole('status')
    .filter({ hasText: 'Offline. Send once you’re back.' })
    .waitFor();
  const send = composer.getByRole('button', { name: 'Send', exact: true });
  const later = composer.getByRole('button', { name: 'Send later', exact: true });
  expect({ send: await send.isDisabled(), later: await later.isDisabled() }).toEqual({
    send: true,
    later: true,
  });
  await message.press('ControlOrMeta+Enter');
  await page.waitForTimeout(1_000);
  expect(await message.textContent()).toBe('Kept until the network is back.');
  await page.screenshot({ path: join(SHOTS, 'offline-desktop-light-send.png') });

  // The conversation the reload opened, from what was kept, asked for no read mark it couldn't make.
  expect(await page.getByText(/Couldn.t mark read/).count()).toBe(0);

  // Back online, what was written saves, and Send can go.
  await context.setOffline(false);
  await composer.getByRole('status').filter({ hasText: 'Saved to Drafts' }).waitFor();
  expect(await send.isDisabled()).toBe(false);
  expect(errors).toEqual([]);
  await context.close();
}, 60_000);

test('back online, the installed app catches up with what changed, with no reload', async () => {
  const { context, page, errors } = await installed();
  await openConversation(page, 0);
  await page.waitForFunction(async () => (await keptCount()) >= 3, undefined, { polling: 200 });
  await context.setOffline(true);
  await page.reload();
  await page.getByText('Offline: kept mail').waitFor();
  await page.getByRole('option').filter({ hasText: NEVER_OPENED }).first().click();
  const reader = page.locator('section[aria-label="Reader"]');
  await reader.getByRole('alert').waitFor();
  // The page that reloaded offline, which a reload would replace.
  await page.evaluate(() => Object.assign(window, { offlineLoad: true }));

  // Another device, online, archives a conversation this one still lists.
  const archived = /Invoice for October/;
  await page.getByRole('option').filter({ hasText: archived }).first().waitFor();
  const other = await (await app.context(SIZES.desktop)).newPage();
  await other.goto(app.url);
  const row = other.getByRole('option').filter({ hasText: archived }).first();
  await row.click();
  await other.keyboard.press('e');
  await row.waitFor({ state: 'detached' });

  await context.setOffline(false);
  await page.getByText('Up to date').waitFor();
  await page
    .getByRole('option')
    .filter({ hasText: archived })
    .first()
    .waitFor({ state: 'detached', timeout: 15_000 });
  // The conversation it couldn't open opens by itself.
  await reader.locator('article').first().waitFor();
  expect(await reader.getByRole('alert').count()).toBe(0);
  expect(await page.evaluate(() => 'offlineLoad' in window)).toBe(true);
  await page.screenshot({ path: join(SHOTS, 'online-desktop-light-caught-up.png') });
  expect(errors).toEqual([]);
  await context.close();
}, 60_000);

test('losing the network while open, the installed app still opens the conversations it kept', async () => {
  const { context, page } = await installed();
  // HTML mail, far enough down that a new start doesn't prepare it ahead. Rows move with the
  // clock, so it is found by its subject.
  const designReview = /Design review notes/;
  const subject = await openConversation(page, designReview);
  await page.waitForFunction(async () => (await keptCount()) >= 5, undefined, { polling: 200 });
  // A new start at the bare Inbox, whose address opens nothing, so the conversation is kept on the
  // device but not in the page, and the pointer off the list, so resting on its row doesn't fetch
  // it ahead.
  await page.mouse.move(0, 0);
  await page.goto(app.url, { waitUntil: 'networkidle' });
  await context.setOffline(true);
  await page.getByText('Offline: kept mail').waitFor();
  expect(await openConversation(page, designReview)).toBe(subject);
  // One it didn't keep says so, rather than standing as a skeleton while the page waits to ask.
  // Design review notes prepared the conversations around it, so this one lies further down.
  await page
    .getByRole('option')
    .filter({ hasText: /Sync service rewrite/ })
    .first()
    .click();
  const reader = page.locator('section[aria-label="Reader"]');
  const unkept = reader.getByRole('alert').filter({ hasText: 'It opens once you’re back online' });
  await unkept.waitFor();
  // So does the next, reached by key, whose page waits for the network to ask again.
  const before = await reader.locator('h1').textContent();
  await page.keyboard.press('j');
  await page.waitForFunction(
    (before) => document.querySelector('section[aria-label="Reader"] h1')?.textContent !== before,
    before,
  );
  await unkept.waitFor({ timeout: 5_000 });
  await context.close();
}, 60_000);

test('what a device kept of another Mailroom never shows, and goes', async () => {
  for (const owner of ['ours', 'another']) {
    const { context, page } = await installed();
    await openConversation(page, 0);
    await page.waitForFunction(async () => (await keptCount()) >= 3, undefined, { polling: 200 });
    // The kept accounts become a stranger's, and this device's owner is ours or another's.
    await page.evaluate(async (owner) => {
      await keptWith('accounts', (accounts: { name: string }[]) =>
        accounts.map((account) => ({ ...account, name: 'Mallory' })),
      );
      if (owner === 'another') localStorage.setItem('trail-mix.cache', 'another Mailroom');
    }, owner);
    // The network's accounts come late, so only kept ones could show before them.
    await page.route(/accounts/, async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      await route.continue();
    });
    await page.reload();
    await page.waitForTimeout(1_000);
    const stranger = await page.getByText('Mallory').count();
    expect({ owner, shown: stranger > 0 }).toEqual({ owner, shown: owner === 'ours' });
    await context.close();
  }
}, 60_000);

test('a browser tab keeps nothing, and its page loads as it always has', async () => {
  const context = await app.context();
  const page = await context.newPage();
  await page.goto(app.url, { waitUntil: 'networkidle' });
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => navigator.serviceWorker.getRegistrations())).toHaveLength(0);
  await context.close();
});

/**
 * A page of Trail Mix run as an installed app, once its worker has kept the build, and the errors
 * its pages throw.
 */
async function installed(options: BrowserContextOptions = SIZES.desktop) {
  const context = await app.context(options);
  await context.addInitScript(runInstalled);
  await context.addInitScript(kept);
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(app.url, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null, undefined, {
    timeout: 15_000,
  });
  return { context, page, errors };
}

/**
 * Opens a row's conversation, by its place in the list or its subject, and waits for the reader to
 * show it, with its open message drawn. Returns its subject. The reader may already show another
 * conversation, as one the address opened.
 */
async function openConversation(page: Page, row: number | RegExp): Promise<string> {
  const rows = page.getByRole('option');
  const option = typeof row === 'number' ? rows.nth(row) : rows.filter({ hasText: row }).first();
  const listed = (await option.textContent()) ?? '';
  await option.click();
  const subject = page.locator('section[aria-label="Reader"] h1');
  // It shows the row's conversation, and its open messages show their bodies: HTML in a frame sized
  // to it, or plain text, which has none.
  await page.waitForFunction((listed) => {
    const reader = document.querySelector('section[aria-label="Reader"]');
    const shown = reader?.querySelector('h1')?.textContent ?? '';
    const sheets = [...(reader?.querySelectorAll('article') ?? [])];
    return (
      shown !== '' &&
      listed.includes(shown) &&
      sheets.length > 0 &&
      sheets.every(
        (sheet) =>
          !sheet.querySelector('[aria-busy="true"], [role="alert"]') &&
          [...sheet.querySelectorAll('iframe')].every(
            (frame) => frame.style.visibility === 'visible',
          ),
      )
    );
  }, listed);
  return (await subject.textContent()) ?? '';
}

/** Helpers on the page for what the app keeps in IndexedDB. */
function kept() {
  const store = async (mode: IDBTransactionMode) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('trail-mix');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('IndexedDB would not open.'));
    });
    return database.transaction('snapshots', mode).objectStore('snapshots');
  };
  const done = <T>(request: IDBRequest<T>) =>
    new Promise<T>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('IndexedDB failed.'));
    });
  Object.assign(window, {
    keptCount: async () => done((await store('readonly')).count()),
    keptNothing: async () => {
      await done((await store('readwrite')).clear());
      localStorage.removeItem('trail-mix.cache');
    },
    keptWith: async (kind: string, change: (data: unknown) => unknown) => {
      const key = `snapshot-${JSON.stringify([kind])}`;
      const snapshot = (await done((await store('readonly')).get(key))) as {
        state: { data: unknown };
      };
      snapshot.state.data = change(snapshot.state.data);
      await done((await store('readwrite')).put(snapshot, key));
    },
  });
}

declare global {
  function keptCount(): Promise<number>;
  function keptNothing(): Promise<void>;
  function keptWith(kind: string, change: (data: never) => unknown): Promise<void>;
}

/** Has the page believe it runs as an installed app, as a home-screen or desktop app does. */
function runInstalled() {
  const real = window.matchMedia.bind(window);
  window.matchMedia = (query: string) =>
    query === '(display-mode: standalone)'
      ? ({ matches: true, media: query } as MediaQueryList)
      : real(query);
}
