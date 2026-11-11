import { beforeAll, expect } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { BrowserContext, BrowserContextOptions, Locator, Page } from 'playwright';
import { ACCENT_STORAGE_KEY } from '../../src/app/theme/accent.ts';
import { parseHex } from '../../src/shared/color.ts';
import { DESK_HEX } from '../../src/app/theme/palette.ts';
import { accentRule, accentTokens } from '../../src/app/theme/readableAccent.ts';
import { PAGE_SIZE } from '../../src/features/mailroom/client/contract.ts';
import { textContrasts, unreadableText } from './contrast.ts';
import { suite } from './suite.ts';

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
          await page.waitForTimeout(400);
          const shot = [size, colorScheme, screen, accent?.slice(1)].filter(Boolean).join('-');
          await page.screenshot({ path: join(SHOTS, `${shot}.png`) });
          expect({ screen: shot, unreadable: await unreadableText(page) }).toEqual({
            screen: shot,
            unreadable: [],
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

test('every row is one height, the first with no preview too, so no two overlap', async () => {
  for (const [size, options] of Object.entries(SIZES)) {
    const { context, page, problems } = await open(options);
    const inbox = await rowsDrawn(page);
    const subject = await writeNothing(page);
    const drafts = page.getByRole('button', { name: /^Drafts/ }).first();
    if (!(await inView(drafts)))
      await page.getByRole('button', { name: 'Folders', exact: true }).click();
    await drafts.click();
    await page.getByRole('option').first().filter({ hasText: subject }).waitFor();

    const rows = await rowsDrawn(page);
    expect({ size, preview: rows[0]?.preview }).toEqual({ size, preview: '' });
    const height = inbox[0]?.height ?? 0;
    expect(height).toBeGreaterThan(0);
    // Rows lie on whole pixels, each the height of a row of mail rounded up.
    const pitch = Math.ceil(height);
    for (const row of [...inbox, ...rows]) {
      expect({ size, row: row.index, height: row.height }).toEqual({
        size,
        row: row.index,
        height,
      });
      expect({ size, row: row.index, top: row.top }).toEqual({
        size,
        row: row.index,
        top: row.index * pitch,
      });
    }
    expect(problems).toEqual([]);
    await context.close();
  }
}, 60_000);

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
    const scrolled = await page.evaluate(async () => {
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
        // Rows lie on whole pixels, each the height of a row of mail rounded up.
        const pitch = Math.ceil(height);
        lengths.add(list.scrollHeight);
        for (const row of list.querySelectorAll('[role="option"]')) {
          const box = row.getBoundingClientRect();
          const index = Number(row.getAttribute('aria-posinset')) - 1;
          heights.add(box.height);
          reached = Math.max(reached, index);
          if (Math.abs(box.top - canvas - index * pitch) > 0.5) {
            misplaced.push(`row ${index} at ${box.top - canvas}, not ${index * pitch}`);
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
    });
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
  await page.waitForFunction(() =>
    document.getAnimations().every(({ playState }) => playState !== 'running'),
  );
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

test('a saved theme paints the desk, and the browser’s chrome, before any of the app runs', async () => {
  for (const [saved, system] of [
    ['dark', 'light'],
    ['light', 'dark'],
  ] as const) {
    const context = await app.context({ colorScheme: system });
    await context.addInitScript((mode) => localStorage.setItem('trail-mix.theme', mode), saved);
    const page = await context.newPage();
    await page.route(/\.js(\?|$)/, (route) => route.abort());
    await page.goto(app.url, { waitUntil: 'load' });
    expect(await page.evaluate(() => getComputedStyle(document.body).colorScheme)).toBe(saved);
    expect(await chromeColors(page)).toEqual([DESK_HEX[saved], DESK_HEX[saved]]);
    await context.close();
  }
});

test('the browser’s chrome follows the theme as it is switched', async () => {
  const { context, page, problems } = await open({ ...SIZES.desktop, colorScheme: 'dark' });
  const each = [DESK_HEX.light, DESK_HEX.dark];
  expect(await chromeColors(page)).toEqual(each);
  // System, then Light, then Dark.
  await page.getByRole('button', { name: 'Theme: System' }).click();
  expect(await chromeColors(page)).toEqual([DESK_HEX.light, DESK_HEX.light]);
  await page.getByRole('button', { name: 'Theme: Light' }).click();
  expect(await chromeColors(page)).toEqual([DESK_HEX.dark, DESK_HEX.dark]);
  await page.getByRole('button', { name: 'Theme: Dark' }).click();
  expect(await chromeColors(page)).toEqual(each);
  expect(problems).toEqual([]);
  await context.close();
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

test('an accent picked beside the theme choice shows at once, outlasts a reload, and goes back to ink blue', async () => {
  const { context, page, problems } = await open(SIZES.desktop);
  const inkBlue = await accentShown(page);
  const picker = page.getByLabel('Accent color');
  const newMessage = page.getByRole('button', { name: 'New message' });
  // The button eases from one color to the next, so it is read once that has finished.
  const buttonOf = () =>
    newMessage.evaluate(async (button) => {
      await Promise.all(button.getAnimations().map(({ finished }) => finished));
      return getComputedStyle(button).backgroundColor;
    });
  expect(await buttonOf()).toBe(inkBlue);

  await picker.fill('#c2185b');
  const picked = shownAs(accentTokens(parseHex('#c2185b')!, 'light').accent);
  expect(await accentShown(page)).toBe(picked);
  expect(await buttonOf()).toBe(picked);

  await page.reload({ waitUntil: 'networkidle' });
  expect(await accentShown(page)).toBe(picked);
  expect(await picker.inputValue()).toBe('#c2185b');

  // The palette opens the same picker.
  await page.evaluate(() => {
    HTMLInputElement.prototype.showPicker = function (this: HTMLInputElement) {
      this.dataset['shown'] = 'true';
    };
  });
  await page.getByRole('searchbox', { name: 'Search mail' }).click();
  await page.keyboard.type('choose an accent');
  await page.getByRole('listbox', { name: 'Commands' }).getByRole('option').first().waitFor();
  await page.keyboard.press('Enter');
  expect(await picker.getAttribute('data-shown')).toBe('true');

  await page.getByRole('button', { name: 'Use the default accent' }).click();
  expect(await accentShown(page)).toBe(inkBlue);
  expect(await page.getByRole('button', { name: 'Use the default accent' }).count()).toBe(0);
  await page.reload({ waitUntil: 'networkidle' });
  expect(await accentShown(page)).toBe(inkBlue);
  expect(problems).toEqual([]);
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
  // Long enough idle for the reader to prepare the conversations beside the open one.
  await page.waitForTimeout(3_000);

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
  await page.waitForTimeout(1_000);

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

  // ⌘K lists every command but its own, and typing part of a title highlights the best match.
  await expect(field.getAttribute('placeholder')).resolves.toBe('Search and commands');
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

  // So does a quick typist's Enter, straight after the last key.
  await page.keyboard.press('ControlOrMeta+k');
  await page.keyboard.type('go to drafts');
  await page.keyboard.press('Enter');
  await page.getByRole('heading', { name: 'Drafts', level: 2 }).waitFor({ timeout: 5_000 });
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

test('the list’s header shows its view’s icon, and the buttons for what is open or selected', async () => {
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
  await page
    .getByRole('region', { name: 'Personal' })
    .getByRole('button', { name: /^Sent/ })
    .click();
  await page.getByRole('heading', { name: 'Sent', level: 2 }).waitFor();
  const [sent, sentRow] = await icons();
  expect(sent).toBe(sentRow);
  await sidebar
    .getByRole('button', { name: /^Inbox/ })
    .first()
    .click();
  await page.getByRole('heading', { name: 'Inbox', level: 2 }).waitFor();

  // With nothing open, the buttons are there but can't be pressed, and opening one moves nothing.
  const header = list.getByRole('toolbar', { name: 'Conversation' });
  const buttons = header.getByRole('button');
  const names = ['Archive', 'Delete', 'Move to', 'Flag', 'More'];
  expect(
    await buttons.evaluateAll((all) => all.map((button) => button.getAttribute('aria-label'))),
  ).toEqual(names);
  const states = (): Promise<{ disabled: boolean; left: number }[]> =>
    buttons.evaluateAll((all) =>
      all.map((button) => ({
        disabled:
          button.hasAttribute('disabled') || button.getAttribute('aria-disabled') === 'true',
        left: Math.round(button.getBoundingClientRect().left),
      })),
    );
  const idle = await states();
  expect(idle.every(({ disabled }) => disabled)).toBe(true);
  await openConversation(page, 1);
  const opened = await states();
  expect(opened.map(({ disabled }) => disabled)).toEqual(names.map(() => false));
  expect(opened.map(({ left }) => left)).toEqual(idle.map(({ left }) => left));
  // The reader's bar keeps only its place while the list shows.
  const place = page.getByRole('toolbar', { name: 'Place' });
  await place.getByRole('button', { name: 'Next conversation' }).waitFor();
  await expect(place.getByRole('button', { name: 'Archive' }).count()).resolves.toBe(0);

  // A selection of several takes the same buttons, and its sheet keeps only its count.
  const rows = page.getByRole('option');
  await rows.nth(2).click({ modifiers: ['Shift'] });
  await page.getByRole('heading', { name: '2 conversations selected' }).waitFor();
  await list
    .getByRole('toolbar', { name: 'Selected conversations' })
    .getByRole('button', { name: 'Archive' })
    .waitFor();
  const selection = page.getByRole('region', { name: 'Selection' });
  await expect(selection.getByRole('button', { name: 'Archive' }).count()).resolves.toBe(0);
  await selection.getByRole('button', { name: 'Clear selection' }).click();

  // With the list folded to its rail, the reader stands alone and takes the buttons back.
  await openConversation(page, 1);
  const edge = page.getByRole('separator', { name: 'Resize the conversation list' });
  await edge.focus();
  await page.keyboard.press('Enter');
  await page
    .locator('section[aria-label="Reader"]')
    .getByRole('toolbar', { name: 'Conversation' })
    .getByRole('button', { name: 'Archive' })
    .waitFor();
  await page.keyboard.press('Enter');
  await header.waitFor();
  expect(problems).toEqual([]);
  await context.close();
}, 30_000);

test('on a phone, the list’s header has no buttons, and the reader’s island files what’s open', async () => {
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
  const bar = page.getByRole('toolbar', { name: 'Place' });
  const rows = page.getByRole('option');
  const listed = async () => Number(await rows.first().getAttribute('aria-setsize'));
  // The reader shows the selected row once its keys rest, and says where that row sits.
  const shows = (place: string) =>
    page.waitForFunction(
      (place) => {
        const title = document.querySelector('section[aria-label="Reader"] h1')?.textContent;
        const row = document.querySelector('[role="option"][aria-selected="true"]');
        const bar = document.querySelector('[role="toolbar"][aria-label="Place"]');
        return title && row?.textContent?.includes(title) && bar?.textContent?.includes(place);
      },
      place,
      { timeout: 5_000 },
    );

  // The place counts the whole Inbox, though only its first page has arrived.
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

  // New message tops the sidebar, and opens a message of its own.
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

/** The list's rows drawn now: where each lies in the list, its height, and its preview's text. */
function rowsDrawn(page: Page) {
  return page.evaluate(() => {
    const list = document.querySelector('[role="listbox"][aria-multiselectable]');
    const canvas = list?.lastElementChild?.getBoundingClientRect().top ?? 0;
    return [...(list?.querySelectorAll('[role="option"]') ?? [])].map((row) => {
      const box = row.getBoundingClientRect();
      return {
        index: Number(row.getAttribute('aria-posinset')) - 1,
        top: box.top - canvas,
        height: box.height,
        preview: row.lastElementChild?.lastElementChild?.textContent ?? undefined,
      };
    });
  });
}

/** Whether a control is in a pane on screen. A pane off a phone's screen is inert. */
async function inView(locator: Locator): Promise<boolean> {
  return (await locator.count()) > 0 && locator.evaluate((element) => !element.closest('[inert]'));
}
