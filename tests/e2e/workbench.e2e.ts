import { beforeAll, expect, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { BrowserContextOptions, Locator, Page } from 'playwright';
import { unreadableText } from './contrast.ts';
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

const app = suite();

beforeAll(() => {
  mkdirSync(SHOTS, { recursive: true });
});

/** A page that records every console error and failed response, to assert there were none. */
async function open(options: BrowserContextOptions, path = '/') {
  const context = await app.context({ deviceScaleFactor: 2, ...options });
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

test('every screen renders cleanly, with readable text, at both sizes in both themes', async () => {
  for (const [size, options] of Object.entries(SIZES)) {
    for (const colorScheme of THEMES) {
      const { context, page, problems } = await open({ ...options, colorScheme });
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
      for (const [screen, reach] of screens) {
        await reach(page);
        await page.waitForTimeout(400);
        await page.screenshot({ path: join(SHOTS, `${size}-${colorScheme}-${screen}.png`) });
        expect({
          screen: `${size} ${colorScheme} ${screen}`,
          unreadable: await unreadableText(page),
        }).toEqual({
          screen: `${size} ${colorScheme} ${screen}`,
          unreadable: [],
        });
      }
      expect(problems).toEqual([]);
      await context.close();
    }
  }
}, 60_000);

test('side panels resize by pointer and key, snap to a rail, and come back the same before the app runs', async () => {
  const { context, page } = await open(SIZES.desktop);
  const sidebar = page.getByRole('separator', { name: 'Resize the sidebar' });
  const list = page.getByRole('separator', { name: 'Resize the conversation list' });
  const size = async (edge: typeof sidebar) => Number(await edge.getAttribute('aria-valuenow'));

  const start = await size(sidebar);
  const box = (await sidebar.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + 200);
  await page.mouse.down();
  await page.mouse.move(box.x + 60, box.y + 200, { steps: 6 });
  await page.mouse.up();
  expect(await size(sidebar)).toBe(start + 57);

  await sidebar.focus();
  await page.keyboard.press('ArrowLeft');
  expect(await size(sidebar)).toBe(start + 57 - 16);

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
  ).toEqual([`${start + 41}px`, '52px']);
  await context.close();
}, 30_000);

test('a saved theme paints the desk before any of the app runs', async () => {
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
    await context.close();
  }
});

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

test('the reader says where its conversation sits, and steps to the ones either side', async () => {
  const { context, page, problems } = await open(SIZES.desktop);
  const bar = page.getByRole('toolbar', { name: 'Conversation' });
  const rows = page.getByRole('option');
  const loaded = async () => Number(await rows.first().getAttribute('aria-setsize'));
  // The reader shows the selected row once its keys rest, and says where that row sits.
  const shows = (place: string) =>
    page.waitForFunction(
      (place) => {
        const title = document.querySelector('section[aria-label="Reader"] h1')?.textContent;
        const row = document.querySelector('[role="option"][aria-selected="true"]');
        const bar = document.querySelector('[role="toolbar"][aria-label="Conversation"]');
        return title && row?.textContent?.includes(title) && bar?.textContent?.includes(place);
      },
      place,
      { timeout: 5_000 },
    );

  // The Inbox has more than its first page, which the place says until the rest are loaded.
  await openConversation(page, 1);
  await shows(`2 of ${await loaded()}+`);
  await bar.getByRole('button', { name: 'Next conversation' }).click();
  await shows(`3 of ${await loaded()}+`);
  await bar.getByRole('button', { name: 'Previous conversation' }).click();
  await shows(`2 of ${await loaded()}+`);

  // A folder whose conversations all came in one page has nothing more to say.
  await page
    .getByRole('region', { name: 'Work' })
    .getByRole('button', { name: /^Receipts/ })
    .click();
  await rows.first().click();
  await shows(`1 of ${await loaded()}`);
  expect(await bar.textContent()).not.toContain(`1 of ${await loaded()}+`);

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

/** Whether a control is in a pane on screen. A pane off a phone's screen is inert. */
async function inView(locator: Locator): Promise<boolean> {
  return (await locator.count()) > 0 && locator.evaluate((element) => !element.closest('[inert]'));
}
