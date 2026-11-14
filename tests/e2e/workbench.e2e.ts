import { beforeAll, expect } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { BrowserContext, BrowserContextOptions, Locator, Page, Route } from 'playwright';
import { ACCENT_STORAGE_KEY } from '../../src/app/theme/accent.ts';
import { parseHex } from '../../src/shared/color.ts';
import { DESK_HEX } from '../../src/app/theme/palette.ts';
import { accentRule, accentTokens } from '../../src/app/theme/readableAccent.ts';
import { PAGE_SIZE } from '../../src/features/mailroom/client/contract.ts';
import { REST_MS } from '../../src/features/reader/core/rest.ts';
import { textContrasts, unusable } from './usable.ts';
import { suite } from './suite.ts';
import { mailIsIn } from '../mailIsIn.ts';
import { atRest } from '../atRest.ts';

/**
 * The smoke suite: the built app, served on workerd, driven in Chromium at a desktop and a phone
 * size in both themes. Screenshots of every screen go to `test-results/`, which CI attaches.
 */

const SHOTS = join(import.meta.dir, '../../test-results');
const SIZES = {
  desktop: { viewport: { width: 1440, height: 900 } },
  phone: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
} satisfies Record<string, BrowserContextOptions>;
const THEMES = ['light', 'dark'] as const;
/** The default, and the palest and the darkest accent a member can pick. */
const ACCENTS = [undefined, '#ffffff', '#000000'] as const;
/** The pixel the list keeps above its first row, where a lifted row's ring lies. */
const RING = 1;

const app = suite();
// A test that fails leaves a screenshot of each page and what it showed, for CI to keep.
const { test } = app;

beforeAll(() => {
  mkdirSync(SHOTS, { recursive: true });
});

/** A page that records every console error and failed response, to assert there were none. */
async function open(options: BrowserContextOptions, { path = '/', accent = '' } = {}) {
  const context = await app.context({ deviceScaleFactor: 2, ...options });
  if (accent) await pickBeforeLoad(context, accent);
  const page = await context.newPage();
  const problems: string[] = [];
  page.on('pageerror', (error) => problems.push(`page error: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(`console: ${message.text()}`);
  });
  page.on('response', (response) => {
    if (response.status() >= 400) problems.push(`${response.status()} ${response.url()}`);
  });
  await page.goto(new URL(path, app.url).href, { waitUntil: 'networkidle' });
  return { context, page, problems };
}

for (const accent of ACCENTS) {
  const named = accent ? ` with ${accent} as the accent` : '';
  test(`every screen renders cleanly, with readable text, at both sizes in both themes${named}`, async () => {
    for (const [size, options] of Object.entries(SIZES)) {
      for (const colorScheme of THEMES) {
        const { context, page, problems } = await open({ ...options, colorScheme }, { accent });
        const screens: [string, (page: Page) => Promise<void>][] = [['list', async () => {}]];
        if (size === 'phone') {
          screens.push([
            'folders',
            (page) => page.getByRole('button', { name: 'Folders', exact: true }).click(),
          ]);
        }
        // The newest conversation, a thread, then the newsletter, which sets its own colors.
        screens.push(['reader', (page) => openConversation(page, 0)]);
        // A reply to it, docked under the conversation.
        screens.push([
          'reply',
          async (page) => {
            // The last Reply answers the newest message: its own on a desktop, the island's on a phone.
            await page
              .getByRole('button', { name: 'Reply', exact: true })
              .locator('visible=true')
              .last()
              .click();
            await page.getByRole('textbox', { name: 'Reply' }).waitFor();
          },
        ]);
        // Escape closes the composer, which on a phone lies over everything.
        screens.push([
          'newsletter',
          async (page) => {
            await page.keyboard.press('Escape');
            await openConversation(page, /Kernel Weekly/);
          },
        ]);
        // Adding an account, from the sidebar, which in the demo says it serves only the demo mailbox.
        screens.push([
          'add-account',
          async (page) => {
            if (size === 'phone') {
              await page
                .getByRole('button', { name: 'Back', exact: true })
                .locator('visible=true')
                .click();
              await page.getByRole('button', { name: 'Folders', exact: true }).click();
            }
            await page.getByRole('button', { name: 'Add account' }).click();
            const form = page.getByRole('form', { name: 'Add an account' });
            await form
              .getByText(
                'This Trail Mix serves only the demo mailbox, so it can’t connect an account of your own.',
              )
              .waitFor();
            expect(await form.getByRole('button', { name: 'Add account' }).isDisabled()).toBe(true);
          },
        ]);
        // A search, whose matches the highlighter marks.
        screens.push(['search', (page) => searchFor(page, 'lunch thu')]);
        // The sidebar folded to its rail, which keeps the search above the list.
        if (size === 'desktop') {
          screens.push([
            'rail',
            (page) => page.getByRole('button', { name: 'Fold the sidebar' }).click(),
          ]);
        }
        for (const [screen, reach] of screens) {
          await reach(page);
          await atRest(page);
          const shot = [size, colorScheme, screen, accent?.slice(1)].filter(Boolean).join('-');
          await page.screenshot({ path: join(SHOTS, `${shot}.png`) });
          expect({ screen: shot, unusable: await unusable(page) }).toEqual({
            screen: shot,
            unusable: [],
          });
        }
        expect(problems).toEqual([]);
        await context.close();
      }
    }
  }, 60_000);
}

test('a row leads with its sender and subject, and sets unread apart by weight and the dot', async () => {
  for (const colorScheme of THEMES) {
    const { context, page, problems } = await open({ ...SIZES.desktop, colorScheme });
    const rows = page.getByRole('option');
    const accent = await accentShown(page);
    const rowOf = async (row: Locator) => {
      const time = await row.locator('time').textContent();
      const texts = (await textContrasts(row)).filter(({ text }) => text !== 'Unread');
      const [sender, , subject, preview] = texts;
      expect(texts[1]?.text).toBe(time!);
      const leads = Math.min(sender!.ratio, subject!.ratio);
      const recedes = Math.max(texts[1]!.ratio, preview!.ratio);
      const weight = await row
        .getByText(sender!.text, { exact: true })
        .evaluate((name) => Number(getComputedStyle(name).fontWeight));
      const hasDot = await row.evaluate(
        (row, accent) =>
          [...row.querySelectorAll('span')].some(
            (span) => getComputedStyle(span).backgroundColor === accent,
          ),
        accent,
      );
      return { leadsBy: leads / recedes, weight, hasDot };
    };
    const read = await rowOf(rows.filter({ hasNotText: 'Unread' }).first());
    const unread = await rowOf(rows.filter({ hasText: 'Unread' }).first());

    // Sender and subject have at least twice the contrast of the time and the preview.
    expect({ colorScheme, read: read.leadsBy >= 2, unread: unread.leadsBy >= 2 }).toEqual({
      colorScheme,
      read: true,
      unread: true,
    });
    expect(unread.weight).toBeGreaterThan(read.weight);
    expect([read.hasDot, unread.hasDot]).toEqual([false, true]);
    expect(problems).toEqual([]);
    await context.close();
  }
});

test('scrolling a long folder never changes a row’s height, moves a row already drawn, or changes the list’s length', async () => {
  for (const [size, options] of Object.entries(SIZES)) {
    const { context, page } = await open(options);
    // A search for the demo's member finds most of their mail, led by a draft with no preview.
    const subject = await writeNothing(page);
    await searchFor(page, 'sam');
    await page
      .locator('[role="listbox"][aria-multiselectable] [role="option"]')
      .first()
      .filter({ hasText: subject })
      .waitFor();
    const scrolled = await page.evaluate(async (ring) => {
      const list = document.querySelector<HTMLElement>('[role="listbox"][aria-multiselectable]');
      if (!list) return { heights: [], lengths: [], misplaced: ['no list'], reached: 0 };
      const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
      const heights = new Set<number>();
      // The list is as long as the search's results from its first page, so the thumb holds one size.
      const lengths = new Set<number>();
      const misplaced: string[] = [];
      let reached = 0;
      let still = 0;
      // Through several pages, each arriving on the way, and no further.
      while (still < 10 && reached < 250) {
        const canvas = list.lastElementChild?.getBoundingClientRect().top ?? 0;
        const height = list.querySelector('[role="option"]')?.getBoundingClientRect().height ?? 0;
        // Rows lie on whole pixels, each the height of a row of mail rounded up, below the pixel
        // the list keeps at its top for a lifted row's ring.
        const pitch = Math.ceil(height);
        lengths.add(list.scrollHeight);
        for (const row of list.querySelectorAll('[role="option"]')) {
          const box = row.getBoundingClientRect();
          const index = Number(row.getAttribute('aria-posinset')) - 1;
          const top = ring + index * pitch;
          heights.add(box.height);
          reached = Math.max(reached, index);
          if (Math.abs(box.top - canvas - top) > 0.5) {
            misplaced.push(`row ${index} at ${box.top - canvas}, not ${top}`);
          }
        }
        const before = list.scrollTop;
        list.scrollTop += list.clientHeight * 0.8;
        await frame();
        await frame();
        if (list.scrollTop === before) {
          still++;
          await new Promise((resolve) => setTimeout(resolve, 100));
        } else still = 0;
      }
      return {
        heights: [...heights],
        lengths: [...lengths],
        misplaced: misplaced.slice(0, 5),
        reached,
      };
    }, RING);
    expect({
      size,
      heights: scrolled.heights.length,
      lengths: scrolled.lengths.length,
      misplaced: scrolled.misplaced,
    }).toEqual({ size, heights: 1, lengths: 1, misplaced: [] });
    // Far past the first page, so pages arrived on the way.
    expect(scrolled.reached).toBeGreaterThan(200);
    await context.close();
  }
}, 120_000);

test('side panels resize by pointer and key, snap to a rail, and come back the same before the app runs', async () => {
  const { context, page } = await open(SIZES.desktop);
  const sidebar = page.getByRole('separator', { name: 'Resize the sidebar' });
  const list = page.getByRole('separator', { name: 'Resize the conversation list' });
  const size = async (edge: typeof sidebar) => Number(await edge.getAttribute('aria-valuenow'));

  const start = await size(sidebar);
  const box = (await sidebar.boundingBox())!;
  const moved = 60 - box.width / 2;
  await page.mouse.move(box.x + box.width / 2, box.y + 200);
  await page.mouse.down();
  await page.mouse.move(box.x + 60, box.y + 200, { steps: 6 });
  await page.mouse.up();
  expect(await size(sidebar)).toBe(start + moved);

  await sidebar.focus();
  await page.keyboard.press('ArrowLeft');
  expect(await size(sidebar)).toBe(start + moved - 16);

  // The sidebar eases to its new width, carrying the list's handle with it, so the handle is found
  // once it has come to rest.
  await atRest(page);
  const listBox = (await list.boundingBox())!;
  await page.mouse.move(listBox.x + listBox.width / 2, listBox.y + 200);
  await page.mouse.down();
  await page.mouse.move(listBox.x - 400, listBox.y + 200, { steps: 6 });
  await page.mouse.up();
  expect(await size(list)).toBe(52);

  // After a reload, the shell paints both sizes before any of the app's code runs.
  const shellOnly = await context.newPage();
  await shellOnly.route(/\.js(\?|$)/, (route) => route.abort());
  await shellOnly.goto(app.url, { waitUntil: 'load' });
  expect(
    await shellOnly.evaluate(() => {
      const style = getComputedStyle(document.documentElement);
      return [
        style.getPropertyValue('--workbench-sidebar'),
        style.getPropertyValue('--workbench-list'),
      ];
    }),
  ).toEqual([`${start + moved - 16}px`, '52px']);
  await context.close();
}, 30_000);

test('a pane shows its thin scrollbar only while the pointer is over it or keys move in it, and a finger keeps its own', async () => {
  const { context, page } = await open(SIZES.desktop);
  const list = page.locator('[role="listbox"][aria-multiselectable]');
  await list.getByRole('option').first().waitFor();
  const listBox = (await list.boundingBox())!;
  const pointAt = async (x: number, y: number) => {
    await page.mouse.move(x, y);
    await atRest(page);
    return scrollbarsShown(page);
  };
  const over = async (pane: Locator) => {
    const box = (await pane.boundingBox())!;
    return pointAt(box.x + box.width / 2, box.y + box.height / 2);
  };
  const onDesk = () => pointAt(listBox.x + listBox.width / 2, 1);
  const NONE = { tree: 'hidden', list: 'hidden', reader: 'hidden' };

  expect(await onDesk()).toEqual(NONE);
  expect(await over(list)).toEqual({ ...NONE, list: 'thin' });
  expect(await over(page.getByRole('navigation', { name: 'Mailboxes' }))).toEqual({
    ...NONE,
    tree: 'thin',
  });
  expect(await over(page.locator('section[aria-label="Reader"]'))).toEqual({
    ...NONE,
    reader: 'thin',
  });

  // A click leaves focus in the list while the member reads, and that alone shows nothing, but
  // moving by key does.
  await list.getByRole('option').nth(2).click();
  expect(await onDesk()).toEqual(NONE);
  await page.keyboard.press('j');
  await atRest(page);
  expect(await scrollbarsShown(page)).toEqual({ ...NONE, list: 'thin' });
  await context.close();

  const finger = await app.context({
    viewport: { width: 1180, height: 820 },
    isMobile: true,
    hasTouch: true,
  });
  const tablet = await finger.newPage();
  await tablet.goto(app.url);
  await tablet.locator('[role="listbox"][aria-multiselectable] [role="option"]').first().waitFor();
  expect(await scrollbarsShown(tablet)).toEqual({
    tree: 'platform',
    list: 'platform',
    reader: 'platform',
  });
  await finger.close();
});

/** Holds the page's ask for its accounts until `release`, as a Mailroom slow to answer would. */
async function holdAccounts(page: Page) {
  const { promise: released, resolve: release } = Promise.withResolvers<void>();
  await page.route(
    (url) => url.href.includes(encodeURIComponent('"accounts"')),
    async (route) => {
      await released;
      await route.continue().catch(() => {});
    },
  );
  return release;
}

test('the first screen draws every control it settles with, from the first load alone, at both sizes', async () => {
  // The Mailroom is filled first, so both screens compared hold the same mail.
  const filling = await app.context(SIZES.desktop);
  const page = await filling.newPage();
  await page.goto(app.url);
  await mailIsIn(page);
  await filling.close();
  // The first load is what the page's HTML names. Every other chunk waits until the first rows.
  const html = await (await fetch(app.url)).text();
  const firstLoad = new Set([...html.matchAll(/"(\/assets\/[^"]+\.js)"/g)].map(([, path]) => path));
  expect(firstLoad.size).toBeGreaterThan(1);

  // A phone's first rows ask for nothing past the first load. A desktop's open conversation does.
  // Its own ask is held as well, so its bar is drawn from its row however soon it would come.
  let heldBack = 0;
  for (const [size, options] of Object.entries(SIZES)) {
    const context = await app.context({ ...options, serviceWorkers: 'block' });
    const page = await context.newPage();
    const held: Route[] = [];
    const asked: Route[] = [];
    let isHolding = true;
    await page.route(/\/assets\/[^/]+\.js$/, async (route) => {
      const { pathname } = new URL(route.request().url());
      if (isHolding && !firstLoad.has(pathname)) held.push(route);
      else await route.continue();
    });
    await page.route(
      (url) => url.href.includes(encodeURIComponent('"conversation"')),
      async (route) => {
        if (isHolding) asked.push(route);
        else await route.continue();
      },
    );
    await page.goto(app.url);
    await page.getByRole('option').first().waitFor();
    await page.evaluate(() => new Promise(requestAnimationFrame));
    const first = await controls(page);
    const isOpening = await page
      .getByRole('status')
      .filter({ hasText: 'Opening the conversation' })
      .count();
    heldBack += held.length;

    // The composer's code is the last to load, once the member has rested a moment on the first
    // screen, after everything else that loads once it has settled.
    const isComposerLoaded = page.waitForResponse((response) =>
      /\/assets\/Composer-[^/]+\.js$/.test(response.url()),
    );
    isHolding = false;
    await Promise.all([...held, ...asked].map((route) => route.continue()));
    await isComposerLoaded;
    await page.waitForLoadState('networkidle');
    const settled = await controls(page);
    expect(first.screen, `${size}: the controls at the first rows`).toEqual(settled.screen);
    // An open conversation's own controls come with it, while its skeleton holds its place.
    if (settled.conversation.length > 0 && isOpening === 0) {
      expect(first.conversation, `${size}: the open conversation`).toEqual(settled.conversation);
    }
    await context.close();
  }
  expect(heldBack).toBeGreaterThan(0);
}, 90_000);

/**
 * Every control a member can see or reach on the page, as its role, its name and where it is
 * drawn: those of the open conversation apart, and those of the screen around it, the reader's
 * toolbars included.
 */
async function controls(page: Page) {
  const all = await page.evaluate(() =>
    [
      ...document.querySelectorAll<HTMLElement>(
        'button, a[href], input, select, textarea, [role="button"], [role="separator"], [role="tab"], [role="switch"], [role="checkbox"], [role="searchbox"], [role="combobox"]',
      ),
    ]
      .filter(
        (element) =>
          !element.closest('[inert], [aria-hidden="true"]') &&
          element.checkVisibility({ visibilityProperty: true }),
      )
      .map((element) => {
        const { x, y, width, height } = element.getBoundingClientRect();
        const role = element.getAttribute('role') ?? element.tagName.toLowerCase();
        // A count in a name is mail, which can still be arriving, not a control of its own.
        const name = (
          element.getAttribute('aria-label') ??
          element.textContent?.trim().slice(0, 40) ??
          ''
        ).replace(/\d+/g, '#');
        const box = [x, y, width, height].map(Math.round).join(' ');
        const isConversation =
          element.closest('section[aria-label="Reader"]') !== null &&
          element.closest('[role="toolbar"]') === null;
        return { control: `${role} "${name}" at ${box}`, isConversation };
      }),
  );
  return {
    screen: all.filter(({ isConversation }) => !isConversation).map(({ control }) => control),
    conversation: all.filter(({ isConversation }) => isConversation).map(({ control }) => control),
  };
}

test('a reader bar menu reached before its code has come opens once the code is here, and keeps the focus', async () => {
  const context = await app.context({ ...SIZES.desktop, serviceWorkers: 'block' });
  /** A page whose menus' code waits until the returned release. */
  const opened = async () => {
    const page = await context.newPage();
    let release = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    await page.route(/\/assets\/DropdownMenu-[^/]+\.js$/, async (route) => {
      await held;
      await route.continue();
    });
    await page.goto(app.url);
    await page.getByRole('option').first().waitFor();
    const header = page.getByRole('toolbar', { name: 'Conversation' }).first();
    const menu = (name: string) => header.getByRole('button', { name, exact: true });
    // The menu's own button is the one that names the menu it controls.
    const isReal = (name: string) =>
      menu(name).evaluate((button) => button.hasAttribute('aria-controls'));
    expect(await isReal('More')).toBe(false);
    return { page, menu, isReal, release };
  };

  const pressing = await opened();
  await pressing.menu('More').click();
  expect(await pressing.page.getByRole('menu').count()).toBe(0);
  pressing.release();
  await pressing.page.getByRole('menuitem', { name: /^Mark (read|unread)$/ }).waitFor();
  await pressing.page.close();

  const focusing = await opened();
  await focusing.menu('Move to').focus();
  focusing.release();
  await focusing.menu('Move to').and(focusing.page.locator('[aria-controls]')).waitFor();
  expect(
    await focusing.menu('Move to').evaluate((button) => button === document.activeElement),
  ).toBe(true);
  await context.close();
}, 60_000);

test('a device that last saw mail draws the workbench and its skeletons before the Mailroom answers', async () => {
  const context = await app.context(SIZES.desktop);
  const page = await context.newPage();
  await page.goto(app.url);
  await mailIsIn(page);
  await page.waitForFunction(() => localStorage.getItem('trail-mix.has-mail') !== null);

  const release = await holdAccounts(page);
  await page.reload();
  await page.getByRole('navigation', { name: 'Mailboxes' }).waitFor();
  // The list needs no word on the accounts: its skeleton stands in until its own snapshot comes.
  await page
    .getByRole('listbox', { name: 'Inbox' })
    .or(page.getByLabel('Loading Inbox'))
    .first()
    .waitFor();
  expect(await page.getByRole('region', { name: 'Personal' }).count()).toBe(0);
  await page.screenshot({ path: join(SHOTS, 'desktop-light-opening-known.png') });
  release();
  await mailIsIn(page);
  await page.getByRole('option').first().waitFor();
  await context.close();
}, 60_000);

test('a device that hasn’t seen mail waits on a quiet desk, and says it’s opening only after a moment', async () => {
  const context = await app.context(SIZES.desktop);
  const page = await context.newPage();
  // Whether the desk said anything within its first moment, or drew the workbench before the
  // Mailroom answered, from before the app's first script.
  await context.addInitScript(() => {
    const started = performance.now();
    const page = window as unknown as { early: string[] };
    page.early = [];
    new MutationObserver(() => {
      if (document.querySelector('nav[aria-label="Mailboxes"]')) page.early.push('workbench');
      if (
        document.body?.innerText.includes('Opening your mail') &&
        performance.now() - started < 250
      ) {
        page.early.push('word too soon');
      }
    }).observe(document, { childList: true, subtree: true, characterData: true });
  });
  const release = await holdAccounts(page);
  await page.goto(app.url);
  await page.getByText('Opening your mail…').waitFor();
  await page.screenshot({ path: join(SHOTS, 'desktop-light-opening-unknown.png') });
  expect(await page.evaluate(() => (window as unknown as { early: string[] }).early)).toEqual([]);
  release();
  await page.getByRole('navigation', { name: 'Mailboxes' }).waitFor();
  await context.close();
}, 60_000);

test('the desk, and the browser’s chrome, follow the system, whatever an earlier release saved', async () => {
  for (const [saved, system] of [
    ['dark', 'light'],
    ['light', 'dark'],
  ] as const) {
    const context = await app.context({ colorScheme: system });
    await context.addInitScript((mode) => {
      if (!sessionStorage.getItem('seeded')) localStorage.setItem('trail-mix.theme', mode);
      sessionStorage.setItem('seeded', 'yes');
    }, saved);
    const page = await context.newPage();
    // Whether the desk shows the system's scheme: as a probe set to that scheme draws it.
    const deskShown = () =>
      page.evaluate((system) => {
        const probe = document.createElement('div');
        probe.style.colorScheme = system;
        probe.style.backgroundColor = 'var(--color-background-body)';
        document.body.append(probe);
        const expected = getComputedStyle(probe).backgroundColor;
        probe.remove();
        return getComputedStyle(document.body).backgroundColor === expected;
      }, system);
    // Before any of the app runs, the system's theme shows.
    await page.route(/\.js(\?|$)/, (route) => route.abort());
    await page.goto(app.url, { waitUntil: 'load' });
    expect(await deskShown()).toBe(true);
    expect(await chromeColors(page)).toEqual([DESK_HEX.light, DESK_HEX.dark]);
    // Once it runs, the choice is forgotten, and the system's still shows.
    await page.unroute(/\.js(\?|$)/);
    await page.reload();
    await page.getByRole('navigation', { name: 'Mailboxes' }).waitFor();
    expect(await deskShown()).toBe(true);
    expect(await page.evaluate(() => localStorage.getItem('trail-mix.theme'))).toBeNull();
    await context.close();
  }
});

test('a saved accent paints before any of the app runs, made readable in each theme', async () => {
  const pick = '#c2185b';
  for (const colorScheme of THEMES) {
    const context = await app.context({ colorScheme });
    await pickBeforeLoad(context, pick);
    const page = await context.newPage();
    await page.route(/\.js(\?|$)/, (route) => route.abort());
    await page.goto(app.url, { waitUntil: 'load' });
    expect({ colorScheme, accent: await accentShown(page) }).toEqual({
      colorScheme,
      accent: shownAs(accentTokens(parseHex(pick)!, colorScheme).accent),
    });
    await context.close();
  }
});

test('an accent picked in Settings shows at once, outlasts a reload, and goes back to ink blue', async () => {
  const { context, page, problems } = await open(SIZES.desktop);
  const inkBlue = await accentShown(page);
  const picker = page.getByLabel('Accent color');
  const openSettings = () => page.getByRole('button', { name: 'Open settings' }).click();
  await openSettings();
  const newMessage = page.getByRole('button', { name: 'New message' });
  // Its fill shows the accent, read once nothing on it moves.
  const buttonOf = async () => {
    await atRest(newMessage);
    return newMessage.evaluate(
      (button) => getComputedStyle(button.firstElementChild!).backgroundColor,
    );
  };
  expect(await buttonOf()).toBe(inkBlue);

  // A member reaches for the swatch, which opens the system's picker, before any color comes.
  await picker.click();
  await page.waitForLoadState('networkidle');
  await picker.fill('#c2185b');
  const picked = shownAs(accentTokens(parseHex('#c2185b')!, 'light').accent);
  expect(await accentShown(page)).toBe(picked);
  expect(await buttonOf()).toBe(picked);

  await page.reload({ waitUntil: 'networkidle' });
  expect(await accentShown(page)).toBe(picked);
  await openSettings();
  expect(await picker.inputValue()).toBe('#c2185b');

  // The palette opens Settings at the same picker, from anywhere.
  await page.keyboard.press('Escape');
  await page.getByRole('region', { name: 'Settings' }).waitFor({ state: 'detached' });
  await page.evaluate(() => {
    HTMLInputElement.prototype.showPicker = function (this: HTMLInputElement) {
      this.dataset['shown'] = 'true';
    };
  });
  await page.getByRole('searchbox', { name: 'Search mail' }).click();
  await page.keyboard.type('choose an accent');
  await page.getByRole('listbox', { name: 'Commands' }).getByRole('option').first().waitFor();
  await page.keyboard.press('Enter');
  await page.waitForFunction(
    () =>
      document.querySelector<HTMLInputElement>('input[aria-label="Accent color"]')?.dataset[
        'shown'
      ],
  );
  expect(await picker.evaluate((input) => input === document.activeElement)).toBe(true);

  await page.getByRole('button', { name: 'Use the default accent' }).click();
  expect(await accentShown(page)).toBe(inkBlue);
  expect(await page.getByRole('button', { name: 'Use the default accent' }).count()).toBe(0);
  await page.reload({ waitUntil: 'networkidle' });
  expect(await accentShown(page)).toBe(inkBlue);
  expect(problems).toEqual([]);
  await context.close();
}, 30_000);

test('offline, a desktop’s list says so beside its title, and going offline and back moves nothing', async () => {
  const { context, page } = await open(SIZES.desktop);
  const list = page.getByRole('region', { name: 'Inbox' });
  const offline = list.getByRole('status').filter({ hasText: /^Offline/ });
  const places = async () => ({
    header: await list.locator('header').boundingBox(),
    firstRow: await page.getByRole('option').first().boundingBox(),
  });
  // Online, nothing on the page says whether mail is current.
  const online = await places();
  expect(await offline.count()).toBe(0);
  expect(await page.getByText(/Up to date|Checking for mail/).count()).toBe(0);

  await context.setOffline(true);
  await offline.waitFor();
  expect(await places()).toEqual(online);
  await context.setOffline(false);
  await offline.waitFor({ state: 'detached' });
  expect(await places()).toEqual(online);
  await context.close();
});

/** The least time a person takes to choose a color in the system's picker, once it opens. */
const CHOOSING_MS = 300;

test('reaching for the accent in Settings the moment the list shows, on a slowed CPU, loads its math before any pick can come', async () => {
  const context = await app.context({ ...SIZES.desktop, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 6 });
  await page.goto(app.url);
  await page.getByRole('option').first().waitFor();
  await page.getByRole('button', { name: 'Open settings' }).click();
  const picker = page.getByLabel('Accent color');
  await picker.click();
  // The math a pick needs, named by the module it's built from, as the browser fetched it.
  const loadedIn = await page.evaluate(
    async (reached) =>
      new Promise<number>((resolve) => {
        const look = () => {
          const math = performance
            .getEntriesByType('resource')
            .find(({ name }) => /\/assets\/readableAccent-/.test(name));
          if (math) resolve(performance.now() - reached);
          else requestAnimationFrame(look);
        };
        look();
      }),
    await page.evaluate(() => performance.now()),
  );
  // Choosing a color in the system's picker takes a person longer than this, so a pick comes later.
  expect(loadedIn).toBeLessThan(CHOOSING_MS);
  // Sets the pace: the pick comes no sooner than a person could choose.
  await page.waitForTimeout(CHOOSING_MS - loadedIn);
  await picker.fill('#c2185b');
  expect(await accentShown(page)).toBe(shownAs(accentTokens(parseHex('#c2185b')!, 'light').accent));
  await context.close();
}, 30_000);

test('a sheet that sets its own color scheme takes the theme’s colors for that scheme', async () => {
  const { context, page } = await open({ ...SIZES.desktop, colorScheme: 'dark' });
  const inkIn = (scheme: string) =>
    page.evaluate((scheme) => {
      const sheet = document.createElement('div');
      sheet.style.colorScheme = scheme;
      sheet.style.color = 'var(--color-text-primary)';
      document.body.append(sheet);
      const ink = getComputedStyle(sheet).color;
      sheet.remove();
      return ink;
    }, scheme);

  expect(await inkIn('light')).not.toBe(await inkIn('dark'));
  await context.close();
});

test('the reader follows a move made after a rest at once, and waits while a key is held', async () => {
  const { context, page, problems } = await open(SIZES.desktop);
  await openConversation(page, 0);
  await preparedBelow(page);

  const shown = await page.evaluate(async () => {
    const reader = document.querySelector('section[aria-label="Reader"]')!;
    const list = document.querySelector('[role="listbox"]')!;
    const heading = () => reader.querySelector('h1')?.textContent ?? '';
    const option = (index: number) => list.querySelectorAll('[role="option"]')[index]?.textContent;
    const press = () =>
      list.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));

    const before = heading();
    press();
    await new Promise(requestAnimationFrame);
    const afterRest = { before, heading: heading(), row: option(1) };

    // Four more presses, 30 ms apart as a held key's repeats come, never let the selection rest.
    const whileHeld: string[] = [];
    // A conversation still loading shows no heading, and that is not one shown.
    const observer = new MutationObserver(() => {
      const now = heading();
      if (now && now !== (whileHeld.at(-1) ?? afterRest.heading)) whileHeld.push(now);
    });
    observer.observe(reader, { subtree: true, childList: true, characterData: true });
    for (let repeat = 0; repeat < 4; repeat++) {
      await new Promise((resolve) => setTimeout(resolve, 30));
      press();
    }
    await new Promise(requestAnimationFrame);
    const last = list.querySelector('[aria-selected="true"]')?.textContent ?? '';
    while (!heading() || !last.includes(heading())) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    observer.disconnect();
    return { afterRest, whileHeld, last, isLastRow5: last === option(5) };
  });

  expect(shown.afterRest.heading).not.toBe(shown.afterRest.before);
  expect(shown.afterRest.row).toContain(shown.afterRest.heading);
  expect(shown.isLastRow5).toBe(true);
  expect(shown.whileHeld).toHaveLength(1);
  expect(shown.last).toContain(shown.whileHeld[0] ?? '(none)');
  expect(problems).toEqual([]);
  await context.close();
}, 30_000);

test('quick presses never rest, however long a slow phone takes to draw each move', async () => {
  const { context, page, problems } = await open(SIZES.desktop);
  const rows = page.getByRole('option');
  const heading = page.locator('section[aria-label="Reader"] h1');
  // Each conversation is opened once first, so one the reader shows later draws at once.
  for (const row of [1, 2, 3, 4, 0]) {
    await rows.nth(row).click();
    await page.waitForFunction((row: number) => {
      const subject = document.querySelector('section[aria-label="Reader"] h1')?.textContent;
      const text = document.querySelectorAll('[role="option"]')[row]?.textContent ?? '';
      return subject ? text.includes(subject) : false;
    }, row);
  }
  expect(await heading.count()).toBe(1);
  // Sets the pace: the member rests on the conversation before pressing, so the first press opens.
  await page.waitForTimeout(REST_MS);

  const shown = await page.evaluate(async () => {
    const reader = document.querySelector('section[aria-label="Reader"]')!;
    const list = document.querySelector('[role="listbox"]')!;
    const subject = () => reader.querySelector('h1')?.textContent ?? '';
    const before = subject();
    const seen: string[] = [];
    const observer = new MutationObserver(() => {
      const now = subject();
      if (now && now !== (seen.at(-1) ?? before)) seen.push(now);
    });
    observer.observe(reader, { subtree: true, childList: true, characterData: true });

    // Four presses 30 ms apart, each stamped with when it was pressed...
    const presses: KeyboardEvent[] = [];
    for (let press = 0; press < 4; press++) {
      presses.push(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    // ...each handled 200 ms after the last move was drawn, as on a slow phone.
    for (const press of presses) {
      list.dispatchEvent(press);
      await new Promise(requestAnimationFrame);
      const drawnBy = performance.now() + 200;
      while (performance.now() < drawnBy);
    }
    await new Promise(requestAnimationFrame);
    const last = list.querySelector('[aria-selected="true"]')?.textContent ?? '';
    while (!subject() || !last.includes(subject())) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    observer.disconnect();
    return { seen, last };
  });

  // The first press came after a rest, so it opened its conversation, and then only the last.
  expect(shown.seen).toHaveLength(2);
  expect(shown.last).toContain(shown.seen[1] ?? '(none)');
  expect(problems).toEqual([]);
  await context.close();
}, 30_000);

test('the search field is the palette: ⌘K, a click or the phone’s island opens it, and Enter runs the best match', async () => {
  const { context, page, problems } = await open(SIZES.desktop);
  await page.getByRole('option').first().waitFor();
  const field = page.getByRole('searchbox', { name: 'Search mail' });
  const commands = page.getByRole('listbox', { name: 'Commands' });
  const heading = (name: string) => page.getByRole('heading', { name, level: 2 });

  // Beside the sidebar's fold button it says only "Search". ⌘K lists every command but its own,
  // and typing part of a title highlights the best match.
  await expect(field.getAttribute('placeholder')).resolves.toBe('Search');
  await page.keyboard.press('ControlOrMeta+k');
  await expect(field.evaluate((node) => node === document.activeElement)).resolves.toBe(true);
  await commands.getByRole('option').first().waitFor();
  await expect(
    commands.getByRole('option', { name: /^Search and commands/ }).count(),
  ).resolves.toBe(0);
  await page.screenshot({ path: join(SHOTS, 'desktop-light-palette.png') });
  await page.keyboard.type('go to drafts');
  await page.keyboard.press('Enter');
  await heading('Drafts').waitFor();
  await expect(field.inputValue()).resolves.toBe('');
  await expect(commands.count()).resolves.toBe(0);

  // A click into the field works the same, and the arrows move the highlight.
  await field.click();
  await page.keyboard.type('go to');
  await commands.getByRole('option').first().waitFor();
  await page.keyboard.press('ArrowDown');
  await expect(commands.getByRole('option', { selected: true }).textContent()).resolves.toMatch(
    /^Go to Flagged/,
  );
  await page.keyboard.press('Enter');
  await heading('Flagged').waitFor();

  // Esc puts the commands away and leaves what was typed, before it means Back.
  await field.click();
  await page.keyboard.type('archive');
  await commands.waitFor();
  await page.keyboard.press('Escape');
  await expect(commands.count()).resolves.toBe(0);
  await expect(field.inputValue()).resolves.toBe('archive');
  expect(problems).toEqual([]);
  await context.close();

  // A phone reaches it through the list's island.
  const phone = await open(SIZES.phone);
  await phone.page.getByRole('button', { name: 'Search and commands' }).click();
  await phone.page.getByRole('listbox', { name: 'Commands' }).getByRole('option').first().waitFor();
  await phone.page.keyboard.type('go to outbox');
  await phone.page.keyboard.press('Enter');
  await phone.page.getByRole('heading', { name: 'Outbox', level: 2 }).waitFor();
  expect(phone.problems).toEqual([]);
  await phone.context.close();
});

test('Enter runs the best match for what the field holds, even before the palette has drawn it', async () => {
  const { context, page, problems } = await open(SIZES.desktop);
  await page.getByRole('option').first().waitFor();
  const field = page.getByRole('searchbox', { name: 'Search mail' });
  await field.click();
  // The words and Enter land in one moment, before the palette can have drawn them.
  await field.evaluate((input: HTMLInputElement) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
      input,
      'go to outbox',
    );
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    );
  });
  await page.getByRole('heading', { name: 'Outbox', level: 2 }).waitFor({ timeout: 5_000 });
  await expect(field.inputValue()).resolves.toBe('');
  expect(problems).toEqual([]);
  await context.close();
});

test('search finds mail as it is typed, marks what matched, and reads bodies only when asked', async () => {
  const { context, page, problems } = await open(SIZES.desktop);
  const field = page.getByRole('searchbox', { name: 'Search mail' });
  const marks = page.locator('[role="option"] mark');

  await field.fill('lunch thu');
  await page.getByRole('heading', { name: 'Search', level: 2 }).waitFor();
  await marks.first().waitFor();
  const marked = new Set((await marks.allTextContents()).map((text) => text.toLowerCase()));
  expect([...marked].sort()).toEqual(['lunch', 'thu']);

  // A word only a newsletter's body holds, which the index can't see.
  await field.fill('pacing');
  await page.getByText('No matches', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Search message bodies too' }).click();
  const hit = page.getByRole('option').filter({ hasText: 'Kernel Weekly' }).first();
  await hit.waitFor({ timeout: 15_000 });
  await hit.click();
  await page.locator('section[aria-label="Reader"] h1', { hasText: /^Issue \d+/ }).waitFor();

  // Editing the search reads the index again, and clearing it goes back where it began.
  await field.fill('pacin');
  await page.getByRole('button', { name: 'Search message bodies too' }).waitFor();
  await field.fill('');
  await page.getByRole('heading', { name: 'Inbox', level: 2 }).waitFor();
  expect(problems).toEqual([]);
  await context.close();
}, 30_000);

test('the list header names its view and holds only what acts on it, and the reader bar holds triage and place together', async () => {
  const { context, page, problems } = await open(SIZES.desktop);
  const list = page.locator('section[aria-labelledby]').first();
  const sidebar = page.getByRole('navigation', { name: 'Mailboxes' });
  // The header's icon is the one the sidebar shows for the view in it.
  const icons = () =>
    page.evaluate(() => {
      const shape = (svg: Element | null | undefined) => svg?.innerHTML ?? 'none';
      return [
        shape(document.querySelector('section[aria-labelledby] header > svg')),
        shape(document.querySelector('nav [aria-current="page"] svg')),
      ];
    });
  for (const view of [/^Inbox/, /^Outbox/]) {
    await sidebar.getByRole('button', { name: view }).first().click();
    const [header, row] = await icons();
    expect(header).toBe(row);
  }
  // The Outbox lists sends, with nothing to press in its header.
  await expect(list.locator('header [role="toolbar"], header button').count()).resolves.toBe(0);
  await page
    .getByRole('region', { name: 'Personal' })
    .getByRole('button', { name: /^Sent/ })
    .click();
  await page.getByRole('heading', { name: 'Sent', level: 2 }).waitFor();
  const [sent, sentRow] = await icons();
  expect(sent).toBe(sentRow);
  // A folder's menu sits at the header's end, however short its title.
  const folderMenu = list.locator('header').getByRole('button', { name: 'Folder' });
  const menuGap = await folderMenu.evaluate((menu) => {
    const header = menu.closest('header')!;
    const end =
      header.getBoundingClientRect().right - parseFloat(getComputedStyle(header).paddingRight);
    return Math.round(end - menu.getBoundingClientRect().right);
  });
  expect(menuGap).toBe(0);
  await sidebar
    .getByRole('button', { name: /^Inbox/ })
    .first()
    .click();
  await page.getByRole('heading', { name: 'Inbox', level: 2 }).waitFor();
  // The reader's bar keeps triage on its left and the place on its right, with the list shown.
  await page.getByRole('option').nth(1).click();
  await page.locator('section[aria-label="Reader"] h1').waitFor();
  const header = page.getByRole('toolbar', { name: 'Conversation' });
  await header.getByRole('button', { name: 'Archive' }).waitFor();
  const actionNames = ['Archive', 'Delete', 'Move to', 'Flag', 'More'];
  expect(
    (
      await header
        .getByRole('button')
        .evaluateAll((all) => all.map((button) => button.getAttribute('aria-label')))
    ).slice(0, 5),
  ).toEqual(actionNames);
  const place = header
    .locator('span')
    .filter({ hasText: /^\d+ of \d+/ })
    .last();
  await header.getByRole('button', { name: 'Next conversation' }).waitFor();
  const more = (await header.getByRole('button', { name: 'More' }).boundingBox())!;
  const placeBounds = (await place.boundingBox())!;
  expect(more.x + more.width).toBeLessThan(placeBounds.x);
  expect(await headerButtons(list)).toEqual(['Unread only']);

  // A selection of several keeps its own toolbar in its reader sheet.
  const rows = page.getByRole('option');
  await rows.nth(2).click({ modifiers: ['Shift'] });
  await page.getByRole('heading', { name: '2 conversations selected' }).waitFor();
  const selection = page.getByRole('region', { name: 'Selection' });
  await selection
    .getByRole('toolbar', { name: 'Selected conversations' })
    .getByRole('button', { name: 'Archive' })
    .waitFor();
  expect(await headerButtons(list)).toEqual(['Unread only']);
  await selection.getByRole('button', { name: 'Clear selection' }).click();

  // With the list folded to its rail, the same reader bar still holds actions and place.
  await page.getByRole('option').nth(1).click();
  await header.getByRole('button', { name: 'Archive' }).waitFor();
  const edge = page.getByRole('separator', { name: 'Resize the conversation list' });
  await edge.focus();
  await page.keyboard.press('Enter');
  const folded = page
    .locator('section[aria-label="Reader"]')
    .getByRole('toolbar', { name: 'Conversation' });
  await folded.getByRole('button', { name: 'Archive' }).waitFor();
  await folded.getByRole('button', { name: 'Next conversation' }).waitFor();
  await page.keyboard.press('Enter');
  expect(problems).toEqual([]);
  await context.close();
}, 30_000);

test('a folder view keeps its own menu beside the title while the sidebar is folded', async () => {
  const { context, page, problems } = await open(SIZES.desktop);
  const sidebar = page.getByRole('navigation', { name: 'Mailboxes' });
  await page
    .getByRole('region', { name: 'Personal' })
    .getByRole('button', { name: /^Projects/ })
    .click();
  await page.getByRole('heading', { name: 'Projects', level: 2 }).waitFor();

  await page.keyboard.press('ControlOrMeta+b');
  await sidebar.getByRole('button', { name: 'Unfold the sidebar' }).waitFor();
  await atRest(page);

  const list = page.locator('section[aria-labelledby]').first();
  const folderMenu = list.getByRole('toolbar', { name: 'Projects' });
  await folderMenu.getByRole('button', { name: 'Folder' }).click();
  await expect(page.getByRole('menuitem').allTextContents()).resolves.toEqual([
    'New folder in Projects',
    'Rename Projects',
    'Delete Projects',
  ]);
  await page.keyboard.press('Escape');
  await page.screenshot({ path: join(SHOTS, 't75-folder-menu-folded.png') });
  expect({ unusable: await unusable(page) }).toEqual({ unusable: [] });
  expect(problems).toEqual([]);
  await context.close();
}, 30_000);

test('the list shows only unread mail while its filter is on, and keeps the one open until the member leaves it', async () => {
  const { context, page, problems } = await open(SIZES.desktop);
  const list = page.locator('section[aria-labelledby]').first();
  const toggle = list.getByRole('button', { name: 'Unread only' });
  const rows = page.getByRole('option');
  const selected = page.locator('[role="option"][aria-selected="true"]');
  const subject = page.locator('section[aria-label="Reader"] h1');
  const listed = async () => Number(await rows.first().getAttribute('aria-setsize'));
  const listing = (length: number) =>
    page.waitForFunction(
      (length) =>
        Number(document.querySelector('[role="option"]')?.getAttribute('aria-setsize')) === length,
      length,
    );
  const isFiltered = (url: URL) => url.searchParams.get('unread') === '1';
  await rows.first().waitFor();
  await expect(toggle.getAttribute('aria-pressed')).resolves.toBe('false');
  const all = await listed();

  // Pressed, the list holds only its unread conversations and the one open, and the address says so.
  await toggle.click();
  await page.waitForURL(isFiltered);
  await expect(toggle.getAttribute('aria-pressed')).resolves.toBe('true');
  await page.waitForFunction(
    (all) => Number(document.querySelector('[role="option"]')?.getAttribute('aria-setsize')) < all,
    all,
  );
  const drawnRead = await rows.evaluateAll(
    (all) =>
      all.filter(
        (row) =>
          row.getAttribute('aria-selected') !== 'true' && !row.textContent.includes('Unread'),
      ).length,
  );
  expect(drawnRead).toBe(0);
  await page.screenshot({ path: join(SHOTS, 't90-desktop-light-unread.png') });

  // A conversation read under the filter stays listed, and the reader stays on it.
  const isRead = page.waitForResponse(
    (response) => response.request().postData()?.includes('"setFlags"') ?? false,
  );
  const refetched = isRead.then(() =>
    page.waitForRequest((request) => request.url().includes(encodeURIComponent('"conversations"'))),
  );
  const unread = rows
    .filter({ hasText: 'Unread' })
    .filter({ hasNotText: 'trailmix-demo/' })
    .first();
  const wasOpen = (await unread.getAttribute('aria-selected')) === 'true';
  const named = new URL(page.url()).searchParams.get('open');
  await unread.click();
  await subject.waitFor();
  const opened = await subject.textContent();
  await page.waitForFunction(
    () =>
      !document
        .querySelector('[role="option"][aria-selected="true"]')
        ?.textContent.includes('Unread'),
  );
  // The read reaches the Mailroom, whose hint has the list fetched again and drawn.
  await (await refetched).response();
  await page.evaluate(() => new Promise(requestAnimationFrame));
  await expect(selected.count()).resolves.toBe(1);
  await expect(subject.textContent()).resolves.toBe(opened);
  const read = await selected.textContent();

  // A reload keeps the filter, and the conversation open stays listed, though it has been read. The
  // address names the conversation once its selection has rested, and a reload opens what it names.
  await page.waitForFunction(
    ({ wasOpen, named }) => {
      const open = new URL(location.href).searchParams.get('open');
      return open !== null && (wasOpen || open !== named);
    },
    { wasOpen, named },
  );
  await page.reload({ waitUntil: 'networkidle' });
  await selected.waitFor();
  expect(isFiltered(new URL(page.url()))).toBe(true);
  await expect(toggle.getAttribute('aria-pressed')).resolves.toBe('true');
  await expect(selected.textContent()).resolves.toBe(read);
  const readListed = await listed();

  // Leaving it drops it.
  await page.keyboard.press('j');
  await page.waitForFunction(
    (read) =>
      ![...document.querySelectorAll('[role="option"]')].some((row) => row.textContent === read),
    read,
  );
  await listing(readListed - 1);

  // The palette turns it off as the toggle does, and the whole Inbox comes back.
  await page.keyboard.press('ControlOrMeta+k');
  await page.keyboard.type('show all conversations');
  await page.keyboard.press('Enter');
  await page.waitForURL((url) => !isFiltered(url));
  await expect(toggle.getAttribute('aria-pressed')).resolves.toBe('false');
  await listing(all);

  // A view chosen from the sidebar opens unfiltered.
  await toggle.click();
  await page.waitForURL(isFiltered);
  await page
    .getByRole('region', { name: 'Personal' })
    .getByRole('button', { name: /^Inbox/ })
    .click();
  await page.waitForURL((url) => url.searchParams.has('folder') && !isFiltered(url));
  await expect(toggle.getAttribute('aria-pressed')).resolves.toBe('false');
  expect(problems).toEqual([]);
  await context.close();
}, 60_000);

test('a folder with nothing unread, listed only for its unread mail, says so in the list and the reader', async () => {
  const { context, page, problems } = await open(SIZES.desktop);
  const list = page.locator('section[aria-labelledby]').first();
  const toggle = list.getByRole('button', { name: 'Unread only' });
  await page
    .getByRole('region', { name: 'Personal' })
    .getByRole('button', { name: /^Sent/ })
    .click();
  await page.getByRole('heading', { name: 'Sent', level: 2 }).waitFor();
  await page.getByRole('option').first().waitFor();
  // With nothing unread, the filter isn't offered, though an address can still name it.
  await expect(toggle.count()).resolves.toBe(0);
  const filtered = new URL(page.url());
  filtered.searchParams.delete('open');
  filtered.searchParams.set('unread', '1');
  for (const colorScheme of THEMES) {
    await page.emulateMedia({ colorScheme });
    await page.goto(filtered.href, { waitUntil: 'networkidle' });
    await list.getByRole('heading', { name: 'Nothing unread' }).waitFor();
    await page
      .locator('section[aria-label="Reader"]')
      .getByText('Everything here is read.')
      .waitFor();
    await expect(toggle.getAttribute('aria-pressed')).resolves.toBe('true');
    await page.screenshot({ path: join(SHOTS, `t90-desktop-${colorScheme}-nothing-unread.png`) });
    expect({ colorScheme, unusable: await unusable(page) }).toEqual({
      colorScheme,
      unusable: [],
    });
  }

  // Turned off, the folder lists its mail again, and with nothing unread the filter goes.
  await toggle.click();
  await page.getByRole('option').first().waitFor();
  await expect(toggle.count()).resolves.toBe(0);
  expect(problems).toEqual([]);
  await context.close();
}, 30_000);

test('reader triage sits at the left of its bar, with place at the right, in both themes and panes', async () => {
  const screenshot = async (page: Page, name: string) => {
    await page.screenshot({ path: join(SHOTS, `${name}.png`) });
    expect({ name, unusable: await unusable(page) }).toEqual({ name, unusable: [] });
  };
  for (const colorScheme of THEMES) {
    const { context, page, problems } = await open({ ...SIZES.desktop, colorScheme });
    await page.getByRole('option').nth(1).click();
    const reader = page.locator('section[aria-label="Reader"]');
    await reader
      .getByRole('toolbar', { name: 'Conversation' })
      .getByRole('button', { name: 'Archive' })
      .waitFor();
    expect(await page.getByRole('toolbar', { name: 'Place' }).count()).toBe(0);
    await screenshot(page, `t75-desktop-${colorScheme}-list`);

    const rows = page.getByRole('option');
    await rows.nth(3).click({ modifiers: ['Shift'] });
    await page.getByRole('heading', { name: /conversations selected/ }).waitFor();
    const selection = page.getByRole('region', { name: 'Selection' });
    await selection.getByRole('button', { name: 'Archive' }).waitFor();
    await screenshot(page, `t75-desktop-${colorScheme}-selection`);
    await selection.getByRole('button', { name: 'Clear selection' }).click();

    await rows.nth(1).click();
    await reader
      .getByRole('toolbar', { name: 'Conversation' })
      .getByRole('button', { name: 'Archive' })
      .waitFor();
    const listEdge = page.getByRole('separator', { name: 'Resize the conversation list' });
    await listEdge.focus();
    await page.keyboard.press('Enter');
    await page.getByRole('button', { name: /^Show Inbox/ }).waitFor();
    const folded = reader.getByRole('toolbar', { name: 'Conversation' });
    await folded.getByRole('button', { name: 'Next conversation' }).waitFor();
    await screenshot(page, `t75-desktop-${colorScheme}-folded`);
    expect(problems).toEqual([]);
    await context.close();
  }

  for (const colorScheme of THEMES) {
    const { context, page, problems } = await open({ ...SIZES.phone, colorScheme });
    const list = page.locator('section[aria-labelledby]').first();
    await page.getByRole('option').nth(1).click();
    await page
      .getByRole('toolbar', { name: 'Conversation' })
      .getByRole('button', { name: 'Archive' })
      .waitFor();
    expect(await headerButtons(list)).toEqual(['Unread only']);
    await screenshot(page, `t75-phone-${colorScheme}`);
    expect(problems).toEqual([]);
    await context.close();
  }
}, 90_000);

test('a narrow list’s header gives up its unread count, whole, before a letter of its title, under a finger too', async () => {
  const TABLET = { viewport: { width: 1180, height: 820 }, isMobile: true, hasTouch: true };
  for (const [pointer, options] of [
    ['fine', SIZES.desktop],
    ['coarse', TABLET],
  ] as const) {
    for (const width of [380, 560]) {
      const context = await app.context(options);
      await context.addInitScript(
        (width) =>
          localStorage.setItem(
            'trail-mix.panel.list',
            JSON.stringify({ width, isCollapsed: false }),
          ),
        width,
      );
      const page = await context.newPage();
      await page.goto(app.url);
      await page.getByRole('option').first().waitFor();
      await page.getByText(/^\d+ unread$/).waitFor({ state: 'attached' });
      const header = await page.evaluate(() => {
        const header = document.querySelector('section[aria-labelledby] header')!;
        const title = header.querySelector('h2')!;
        const count = [...header.querySelectorAll('span span')].find((span) =>
          /unread$/.test(span.textContent ?? ''),
        )!;
        const box = count.parentElement!.getBoundingClientRect();
        const text = count.getBoundingClientRect();
        return {
          title: title.scrollWidth <= title.clientWidth ? title.textContent : 'truncated',
          // Shown whole, inside its box, or moved out of it.
          count: text.bottom <= box.bottom && text.right <= box.right + 0.5 ? 'whole' : 'hidden',
          shown: text.top < box.bottom ? 'on its line' : 'gone',
        };
      });
      // The count is whole on its line or gone, never cut, and the title stays whole either way.
      const whole = { title: 'Inbox', count: 'whole', shown: 'on its line' };
      const gone = { title: 'Inbox', count: 'hidden', shown: 'gone' };
      expect({ pointer, width, header }).toEqual({
        pointer,
        width,
        header: width === 560 || header.count === 'whole' ? whole : gone,
      });
      await context.close();
    }
  }
}, 60_000);

test('on a phone, the list’s header holds no triage, and the reader’s island files what’s open', async () => {
  const { context, page, problems } = await open(SIZES.phone);
  await expect(page.getByRole('toolbar', { name: 'Conversation' }).count()).resolves.toBe(0);
  await openConversation(page, 1);
  await page
    .getByRole('toolbar', { name: 'Conversation' })
    .getByRole('button', { name: 'Archive' })
    .waitFor();
  expect(problems).toEqual([]);
  await context.close();
}, 30_000);

test('the reader says where its conversation sits, and steps to the ones either side', async () => {
  const { context, page, problems } = await open(SIZES.desktop);
  // A bundle's row is a place like any other, and its sheet's bar says so as a conversation's does.
  const bar = page.getByRole('toolbar', { name: /^(Conversation|Repository)$/ });
  const rows = page.getByRole('option');
  const listed = async () => Number(await rows.first().getAttribute('aria-setsize'));
  // The reader shows the selected row once its keys rest, and says where that row sits.
  const shows = (place: string) =>
    page.waitForFunction(
      (place) => {
        const title = document.querySelector('section[aria-label="Reader"] h1')?.textContent;
        const row = document.querySelector('[role="option"][aria-selected="true"]');
        const bar = document.querySelector(
          '[role="toolbar"][aria-label="Conversation"], [role="toolbar"][aria-label="Repository"]',
        );
        return title && row?.textContent?.includes(title) && bar?.textContent?.includes(place);
      },
      place,
      { timeout: 5_000 },
    );

  // The place counts the whole Inbox, though only its first page has arrived. The third row is the
  // demo's toy-box bundle.
  await openConversation(page, 1);
  const inbox = await listed();
  expect(inbox).toBeGreaterThan(PAGE_SIZE);
  await shows(`2 of ${inbox}`);
  await bar.getByRole('button', { name: 'Next conversation' }).click();
  await shows(`3 of ${inbox}`);
  await bar.getByRole('button', { name: 'Previous conversation' }).click();
  await shows(`2 of ${inbox}`);

  await page
    .getByRole('region', { name: 'Work' })
    .getByRole('button', { name: /^Receipts/ })
    .click();
  await rows.first().click();
  await shows(`1 of ${await listed()}`);

  // New message ends the sidebar's foot, and opens a message of its own.
  await page
    .getByRole('navigation', { name: 'Mailboxes' })
    .getByRole('button', { name: 'New message' })
    .click();
  await page.getByRole('region', { name: 'New message' }).waitFor({ timeout: 5_000 });
  expect(problems).toEqual([]);
  await context.close();
}, 30_000);

/**
 * Opens a conversation from the unified Inbox and waits for its mail. On a phone it first goes back
 * to the list, from the reader or the folders.
 */
/** The colors the shell's theme-color metas give the browser's chrome, light scheme first. */
function chromeColors(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')].map(
      ({ content }) => content,
    ),
  );
}

/** Saves an accent as picking it would, before the page loads. */
async function pickBeforeLoad(context: BrowserContext, color: string) {
  const saved = JSON.stringify({ color, css: accentRule(color) });
  await context.addInitScript(([key, value]) => localStorage.setItem(key, value), [
    ACCENT_STORAGE_KEY,
    saved,
  ] as const);
}

/** The accent as the page paints it, read from an element that takes it as its color. */
function accentShown(page: Page): Promise<string> {
  return page.evaluate(() => {
    const probe = document.createElement('i');
    probe.style.color = 'var(--color-accent)';
    document.body.append(probe);
    const color = getComputedStyle(probe).color;
    probe.remove();
    return color;
  });
}

/** `#rrggbb` as a computed style gives it back. */
function shownAs(hex: string): string {
  const { r, g, b } = parseHex(hex)!;
  return `rgb(${[r, g, b].map((v) => Math.round(v * 255)).join(', ')})`;
}

async function openConversation(page: Page, which: number | RegExp) {
  const back = page.getByRole('button', { name: 'Back', exact: true });
  if (await inView(back)) await back.click();
  const inbox = page.getByRole('button', { name: /^Inbox/ }).first();
  if (await inView(inbox)) await inbox.click();
  const rows = page.getByRole('option');
  await (
    typeof which === 'number' ? rows.nth(which) : rows.filter({ hasText: which }).first()
  ).click();
  await page.waitForFunction(() => {
    const frames = [
      ...document.querySelectorAll<HTMLIFrameElement>('section[aria-label="Reader"] iframe'),
    ];
    return frames.length > 0 && frames.every((frame) => frame.style.visibility === 'visible');
  });
}

/**
 * Waits until the reader has prepared the conversation below the open one, as it does while the
 * browser is idle: its newest body fetched, the page's second after the open one's, and sanitized
 * in an idle moment after it came.
 */
async function preparedBelow(page: Page) {
  await page.waitForFunction(
    (body) =>
      new Set(
        performance
          .getEntriesByType('resource')
          .map(({ name }) => name)
          .filter((name) => name.includes(body)),
      ).size >= 2,
    encodeURIComponent('"body"'),
  );
  await page.evaluate(
    () => new Promise((resolve) => requestIdleCallback(() => requestIdleCallback(resolve))),
  );
}

/** Types a search into the field and waits for the rows it marks. On a phone, from the list. */
async function searchFor(page: Page, text: string) {
  const back = page.getByRole('button', { name: 'Back', exact: true });
  if (await inView(back)) await back.click();
  await page.getByRole('searchbox', { name: 'Search mail' }).fill(text);
  await page.locator('[role="option"] mark').first().waitFor();
}

/**
 * Writes a new message with a subject and nothing else, which leaves the newest draft, one with no
 * preview. Returns its subject.
 */
async function writeNothing(page: Page): Promise<string> {
  const subject = `Nothing written ${Date.now()}`;
  await page.keyboard.press('c');
  await page.keyboard.type('grace@example.com');
  const composer = page.locator('section[aria-label="New message"]');
  await composer.getByRole('textbox', { name: 'Subject' }).fill(subject);
  await page.getByRole('status').filter({ hasText: 'Saved to Drafts' }).waitFor();
  await page.keyboard.press('Escape');
  return subject;
}

/**
 * How the folder tree's, the list's and the reader's scrollbars show now: `hidden`, `thin` while
 * shown, or `platform` where the platform's colors draw them. It waits for the reader to have a
 * scroller, since between two conversations it may briefly have none.
 */
async function scrollbarsShown(page: Page) {
  const shown = await page.waitForFunction(() => {
    const shown = (pane: string) => {
      const root = document.querySelector(pane)!;
      const scroller = [root, ...root.querySelectorAll('*')].find((element) =>
        /auto|scroll/.test(getComputedStyle(element).overflowY),
      );
      if (!scroller) return undefined;
      const { scrollbarColor, scrollbarWidth } = getComputedStyle(scroller);
      if (scrollbarColor === 'auto') return 'platform';
      return scrollbarColor === 'rgba(0, 0, 0, 0) rgba(0, 0, 0, 0)' ? 'hidden' : scrollbarWidth;
    };
    const panes = {
      tree: shown('nav[aria-label="Mailboxes"]'),
      list: shown('[role="listbox"][aria-multiselectable]'),
      reader: shown('section[aria-label="Reader"]'),
    };
    return Object.values(panes).every(Boolean) && panes;
  });
  return shown.jsonValue();
}

/** The names of the buttons in a list's header, which hold only what acts on its view. */
function headerButtons(list: Locator): Promise<(string | null)[]> {
  return list
    .locator('header button')
    .evaluateAll((all) => all.map((button) => button.getAttribute('aria-label')));
}

/** Whether a control is in a pane on screen. A pane off a phone's screen is inert. */
async function inView(locator: Locator): Promise<boolean> {
  return (await locator.count()) > 0 && locator.evaluate((element) => !element.closest('[inert]'));
}
