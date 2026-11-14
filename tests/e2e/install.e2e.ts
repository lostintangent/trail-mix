import { expect } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { BrowserContextOptions, Page } from 'playwright';
import { atRest } from '../atRest.ts';
import { suite } from './suite.ts';
import { mailIsIn } from '../mailIsIn.ts';

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
/**
 * How soon after an offline reload's start the kept Inbox and the conversation open in it show, or,
 * on a device that kept nothing, the word that the app can't reach the mail. Nothing they need
 * waits on the network, so they come as fast as the page draws.
 */
const OFFLINE_WITHIN_MS = 1_000;
/**
 * The Inbox list's header offline: its title whole, and the status's words beside it, as many as
 * the fonts leave room for, but at least that it's offline, all of them said to assistive
 * technology. The system font of a Mac or an iPhone leaves room for all of them on a phone, and a
 * wider one, as Linux's, for one fewer.
 */
const HEADER_OFFLINE = {
  title: 'Inbox',
  isWhole: true,
  shows: expect.stringMatching(/^Offline(: kept mail)?$/) as string,
  says: 'Offline: kept mail',
};
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

// install.test.ts holds every icon to its size, and installing fetches the manifest's.
test('the shell names a touch icon the Worker serves as a PNG', async () => {
  const context = await app.context();
  const page = await context.newPage();
  await page.goto(app.url, { waitUntil: 'load' });
  const touch = await page.locator('link[rel="apple-touch-icon"]').getAttribute('href');
  expect(touch).toBe('/icons/apple-touch-icon.png');
  const response = await page.request.get(new URL(touch!, app.url).href);
  expect(response.headers()['content-type']).toBe('image/png');
  await context.close();
});

test('the installed app with nothing kept opens offline, and says at once it can’t reach the mail', async () => {
  for (const [size, colorScheme] of [
    ['desktop', 'light'],
    ['phone', 'dark'],
  ] as const) {
    const { context, page, errors } = await installed({ ...SIZES[size], colorScheme });
    await page.evaluate(() => keptNothing());

    await context.addInitScript(noteShown);
    await context.setOffline(true);
    await page.reload();
    // The shell and the app's code came from the worker, so the app runs and says what it can't
    // do, without waiting to ask a network the browser says it hasn't got.
    await page
      .getByRole('heading', { name: 'Trail Mix can’t reach your mail' })
      .waitFor({ timeout: 15_000 });
    // Nor does it take away what it drew first while that word's code comes.
    const { at, bare } = await page.evaluate(() => ({
      at: window.unreachableShownAt,
      bare: window.bareAt,
    }));
    const missed = [
      ...(at === undefined || at > OFFLINE_WITHIN_MS
        ? [`said so at ${Math.round(at ?? -1)} ms`]
        : []),
      ...(bare === undefined ? [] : [`a bare desk at ${Math.round(bare)} ms`]),
    ];
    expect({ size, missed }).toEqual({ size, missed: [] });
    // And why, in plain words, not the browser's.
    await page.getByText('This device is offline.', { exact: true }).waitFor();
    await page.screenshot({ path: join(SHOTS, `offline-${size}-${colorScheme}-unreachable.png`) });
    expect({ size, errors }).toEqual({ size, errors: [] });
    await context.close();
  }
}, 60_000);

test('the installed app opens offline to the lists and conversations it showed', async () => {
  const { context, page } = await installed();
  const subjects: string[] = [];
  for (const row of [0, 1, 2]) subjects.push(await openConversation(page, row));
  // Each conversation and its open body is kept as it arrives.
  await page.waitForFunction(async (least) => (await keptCount()) >= least, 9, { polling: 200 });

  await context.setOffline(true);
  await page.reload();
  await page.getByText('Offline: kept mail').waitFor();
  // Beside the open conversation's buttons, with the list at its first width, the title shows
  // whole, and the status gives way before it, a whole word at a time, at a desktop's width and a
  // laptop's.
  for (const width of [1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    expect({ width, ...(await listHeader(page)) }).toEqual({ width, ...HEADER_OFFLINE });
  }
  await page.screenshot({ path: join(SHOTS, 'desktop-light-offline.png') });
  for (const [row, subject] of subjects.entries()) {
    expect({ row, opened: await openConversation(page, row) }).toEqual({ row, opened: subject });
  }
  await context.close();
}, 60_000);

test('the installed app reads offline at both sizes in both themes: the Inbox and what it opened', async () => {
  // Each size in one theme, so both themes and both sizes show.
  for (const [size, colorScheme] of [
    ['desktop', 'light'],
    ['phone', 'dark'],
  ] as const) {
    const { context, page, errors } = await installed({ ...SIZES[size], colorScheme });
    const subject = await openConversation(page, 0);
    await page.waitForFunction(async () => (await keptCount()) >= 3, undefined, { polling: 200 });

    await context.addInitScript(noteShown);
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
    const shown = await page.evaluate(() => ({ rows: rowsShownAt, reader: readerShownAt }));
    const late = Object.entries(shown).flatMap(([what, at]) =>
      at === undefined || at > OFFLINE_WITHIN_MS ? [`${what} at ${Math.round(at ?? -1)} ms`] : [],
    );
    expect({ size, colorScheme, late }).toEqual({ size, colorScheme, late: [] });
    await page.screenshot({ path: join(SHOTS, `offline-${size}-${colorScheme}.png`) });
    if (size === 'phone') {
      await page.getByRole('button', { name: 'Back', exact: true }).click();
      await page.getByRole('option').first().waitFor();
      // The list says it beside its title, at every width.
      await page
        .getByRole('region', { name: 'Inbox' })
        .getByRole('status')
        .filter({ hasText: 'Offline: kept mail' })
        .waitFor();
      // The list has slid back into view.
      await atRest(page);
      expect({ colorScheme, ...(await listHeader(page)) }).toEqual({
        colorScheme,
        ...HEADER_OFFLINE,
      });
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
}, 60_000);

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
  // Nothing happened, so the selection the archive moved on comes back to it, and the reader with it.
  await page
    .getByRole('option', { selected: true })
    .filter({ hasText: NEVER_OPENED })
    .waitFor({ timeout: 5_000 });
  await page.waitForFunction(() =>
    /Trip photos/.test(
      document.querySelector('section[aria-label="Reader"] h1')?.textContent ?? '',
    ),
  );
  await reader.getByRole('alert').filter({ hasText: 'It opens once you’re back online' }).waitFor();
  await page.screenshot({ path: join(SHOTS, 'offline-desktop-light-archive.png') });

  // Writing offline is out of scope, so Send and Send later wait, plainly, and say why, and what was
  // written stays.
  await page.keyboard.press('c');
  const composer = page.getByRole('region', { name: 'New message' });
  await composer.getByRole('combobox', { name: 'To' }).fill('sam@trailmix.test');
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
  // Send closes the composer in the key's own handler, so by the frame after it would be gone.
  await page.evaluate(() => new Promise(requestAnimationFrame));
  expect(await message.textContent({ timeout: 1_000 })).toBe('Kept until the network is back.');
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

test('on a phone, an archive refused offline puts back the conversation it took away, or what was picked', async () => {
  const { context, page, errors } = await installed(SIZES.phone);
  const subject = await openConversation(page, 0);
  await page.waitForFunction(async () => (await keptCount()) >= 3, undefined, { polling: 200 });
  await context.setOffline(true);
  await page
    .getByRole('toolbar', { name: 'Conversation' })
    .getByRole('button', { name: 'Archive' })
    .click();
  await page
    .getByText(/^Couldn.t archive\. This device is offline\.$/)
    .first()
    .waitFor();
  // The list came back with the row, and then the reader with the conversation, off the list.
  await page.waitForFunction((subject) => {
    const reader = document.querySelector('section[aria-label="Reader"]');
    return reader?.querySelector('h1')?.textContent === subject && !reader.closest('[inert]');
  }, subject);

  // Rows picked come back picked, so a tap still picks rather than opens.
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  // The list slides back in before a finger lands on it.
  await atRest(page);
  await page.waitForFunction(
    () => document.querySelector('section[aria-label="Reader"]')?.closest('[inert]') !== null,
  );
  const options = page.getByRole('option');
  const cdp = await context.newCDPSession(page);
  const press = async (at: number, ms: number) => {
    const box = (await options.nth(at).boundingBox())!;
    const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
    // Sets the pace: how long the finger stays down.
    await page.waitForTimeout(ms);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  };
  await press(1, 700);
  await press(2, 40);
  const picked = page.getByRole('toolbar', { name: 'Picked conversations' });
  await picked.getByRole('button', { name: 'Archive' }).click();
  await page
    .getByText(/^Couldn.t archive\. This device is offline\.$/)
    .first()
    .waitFor();
  await picked.waitFor();
  expect(await picked.textContent()).toContain('2');
  expect(
    await Promise.all([1, 2].map((at) => options.nth(at).getAttribute('aria-selected'))),
  ).toEqual(['true', 'true']);
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
  await mailIsIn(page);
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
    // Whether a stranger's name ever shows, until the network's accounts do.
    await page.addInitScript(() => {
      const watching = new MutationObserver(() => {
        if (!document.body?.textContent.includes('Mallory')) return;
        Object.assign(window, { isStrangerShown: true });
        watching.disconnect();
      });
      watching.observe(document, { subtree: true, childList: true, characterData: true });
    });
    await page.reload();
    await page.getByRole('region', { name: 'Personal' }).waitFor();
    const shown = await page.evaluate(() => 'isStrangerShown' in window);
    expect({ owner, shown }).toEqual({ owner, shown: owner === 'ours' });
    await context.close();
  }
}, 60_000);

test('a browser tab keeps nothing, and its page loads as it always has', async () => {
  const context = await app.context();
  await context.addInitScript(() => {
    const { prototype } = ServiceWorkerContainer;
    const register = Object.getOwnPropertyDescriptor(prototype, 'register')!
      .value as typeof prototype.register;
    prototype.register = function (this: ServiceWorkerContainer, ...args) {
      Object.assign(window, { isWorkerAskedFor: true });
      return register.apply(this, args);
    };
  });
  const page = await context.newPage();
  await page.goto(app.url, { waitUntil: 'networkidle' });
  // An installed app's page asks for its worker in a timer it sets once loaded, which has run once
  // one set now has.
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 0)));
  expect(await page.evaluate(() => 'isWorkerAskedFor' in window)).toBe(false);
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

/**
 * The Inbox list's header: its title, whether it shows whole, the words its status shows, which
 * give way whole onto a line the status hides, and all the status says.
 */
function listHeader(page: Page) {
  return page
    .getByRole('region', { name: 'Inbox', exact: true })
    .locator('header')
    .evaluate((header) => {
      const title = header.querySelector('h2');
      const status = header.querySelector('[role="status"]');
      const end = status?.getBoundingClientRect().bottom ?? 0;
      const shown = [...(status?.children ?? [])].filter(
        (part) => part.getBoundingClientRect().top < end,
      );
      return {
        title: title?.textContent,
        isWhole: title !== null && title.scrollWidth <= title.clientWidth,
        shows: shown.map(({ textContent }) => textContent).join(''),
        says: status?.textContent,
      };
    });
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

/**
 * Notes when the page first drew a list row, an open conversation's message, and the word that it
 * can't reach the mail, from its start, and when it first drew nothing after it had drawn something,
 * as when React hides a screen while the next one's code comes.
 */
function noteShown() {
  const shown = window as unknown as {
    rowsShownAt?: number;
    readerShownAt?: number;
    unreachableShownAt?: number;
    drawnAt?: number;
    bareAt?: number;
  };
  new MutationObserver(() => {
    const now = performance.now();
    if (document.querySelector('[role="option"]')) shown.rowsShownAt ??= now;
    if (document.querySelector('section[aria-label="Reader"] article')) shown.readerShownAt ??= now;
    const headings = [...document.querySelectorAll('h1')];
    if (headings.some(({ textContent }) => textContent === 'Trail Mix can’t reach your mail')) {
      shown.unreachableShownAt ??= now;
    }
    const screens = [...document.querySelectorAll('nav, main, section')];
    if (screens.some((screen) => screen.checkVisibility())) shown.drawnAt ??= now;
    else if (shown.drawnAt !== undefined) shown.bareAt ??= now;
  }).observe(document, { childList: true, subtree: true, attributeFilter: ['style'] });
}

declare global {
  var rowsShownAt: number | undefined;
  var readerShownAt: number | undefined;
  var unreachableShownAt: number | undefined;
  var bareAt: number | undefined;
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
