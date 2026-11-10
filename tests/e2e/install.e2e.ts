import { expect } from 'bun:test';
import type { Page } from 'playwright';
import { ICONS } from '../../src/app/icons.ts';
import { suite } from './suite.ts';

/**
 * Installing Trail Mix: Chromium finds nothing that stops it, and the manifest and icons it asks
 * for arrive with the member's cookie, since Cloudflare Access answers a request without it with
 * its sign-in page.
 */

const app = suite();
const { test } = app;

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
  await page.getByText('Offline. Showing what this device kept').waitFor();
  for (const [row, subject] of subjects.entries()) {
    expect({ row, opened: await openConversation(page, row) }).toEqual({ row, opened: subject });
  }
  await context.close();
}, 60_000);

test('losing the network while open, the installed app still opens the conversations it kept', async () => {
  const { context, page } = await installed();
  // Far enough down that a new start doesn't prepare it ahead.
  const subject = await openConversation(page, 4);
  await page.waitForFunction(async () => (await keptCount()) >= 5, undefined, { polling: 200 });
  // A new start, so the conversation is kept on the device but not in the page.
  await page.reload({ waitUntil: 'networkidle' });
  await context.setOffline(true);
  await page.getByText('Offline. Showing what this device kept').waitFor();
  expect(await openConversation(page, 4)).toBe(subject);
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

/** A page of Trail Mix run as an installed app, once its worker has kept the build. */
async function installed() {
  const context = await app.context({ viewport: { width: 1440, height: 900 } });
  await context.addInitScript(runInstalled);
  await context.addInitScript(kept);
  const page = await context.newPage();
  await page.goto(app.url, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null, undefined, {
    timeout: 15_000,
  });
  return { context, page };
}

/** Opens a row's conversation and waits for its open message to show. Returns its subject. */
async function openConversation(page: Page, row: number): Promise<string> {
  await page.getByRole('option').nth(row).click();
  const subject = page.locator('section[aria-label="Reader"] h1');
  await page.waitForFunction(() => {
    const frames = [
      ...document.querySelectorAll<HTMLIFrameElement>('section[aria-label="Reader"] iframe'),
    ];
    return frames.length > 0 && frames.every((frame) => frame.style.visibility === 'visible');
  });
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
