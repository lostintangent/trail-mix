import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  chromium,
  type Browser,
  type BrowserContextOptions,
  type Locator,
  type Page,
} from 'playwright';
import { startPreview, type Preview } from './preview.ts';

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

let preview: Preview;
let browser: Browser;

beforeAll(async () => {
  mkdirSync(SHOTS, { recursive: true });
  preview = await startPreview();
  browser = await chromium.launch().catch((cause: unknown) => {
    throw new Error('Chromium for Playwright is missing. Run `bunx playwright install chromium`.', {
      cause,
    });
  });
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await preview?.stop();
});

/** A page that records every console error and failed response, to assert there were none. */
async function open(options: BrowserContextOptions, path = '/') {
  const context = await browser.newContext({ deviceScaleFactor: 2, ...options });
  const page = await context.newPage();
  const problems: string[] = [];
  page.on('pageerror', (error) => problems.push(`page error: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(`console: ${message.text()}`);
  });
  page.on('response', (response) => {
    if (response.status() >= 400) problems.push(`${response.status()} ${response.url()}`);
  });
  await page.goto(new URL(path, preview.url).href, { waitUntil: 'networkidle' });
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
      screens.push(['newsletter', (page) => openConversation(page, /Kernel Weekly/)]);
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
  await shellOnly.goto(preview.url, { waitUntil: 'load' });
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
    const context = await browser.newContext({ colorScheme: system });
    await context.addInitScript((mode) => localStorage.setItem('trail-mix.theme', mode), saved);
    const page = await context.newPage();
    await page.route(/\.js(\?|$)/, (route) => route.abort());
    await page.goto(preview.url, { waitUntil: 'load' });
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

/**
 * Opens a conversation from the unified Inbox and waits for its mail. On a phone it first goes back
 * to the list, from the reader or the folders.
 */
async function openConversation(page: Page, which: number | RegExp) {
  // A pane off a phone's screen is inert, so only the pane in view can be used.
  const inView = async (locator: Locator) =>
    (await locator.count()) > 0 && locator.evaluate((element) => !element.closest('[inert]'));
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

/** Every visible text node whose contrast against what lies behind it falls under 4.5:1. */
function unreadableText(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    const ink = canvas.getContext('2d', { willReadFrequently: true })!;
    const rgba = (css: string) => {
      ink.clearRect(0, 0, 1, 1);
      ink.fillStyle = css;
      ink.fillRect(0, 0, 1, 1);
      const [r = 0, g = 0, b = 0, a = 0] = ink.getImageData(0, 0, 1, 1).data;
      return [r, g, b, a / 255] as const;
    };
    type Color = readonly [number, number, number, number];
    const over = (top: Color, bottom: Color): Color => [
      top[0] * top[3] + bottom[0] * (1 - top[3]),
      top[1] * top[3] + bottom[1] * (1 - top[3]),
      top[2] * top[3] + bottom[2] * (1 - top[3]),
      1,
    ];
    const behind = (element: Element): Color => {
      const layers: Color[] = [];
      for (let node: Element | null = element; node; node = node.parentElement) {
        const color = rgba(getComputedStyle(node).backgroundColor);
        if (color[3] > 0) layers.push(color);
        if (color[3] >= 1) break;
      }
      return layers
        .reverse()
        .reduce<Color>((below, layer) => over(layer, below), [255, 255, 255, 1]);
    };
    const luminance = ([r, g, b]: Color) => {
      const linear = (v: number) =>
        (v /= 255) <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
      return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
    };
    const unreadable: string[] = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const element = node.parentElement;
      const text = node.textContent?.trim();
      if (!element || !text || element.closest('[inert], [aria-hidden="true"]')) continue;
      const box = element.getBoundingClientRect();
      if (!box.width || box.right < 0 || box.left > innerWidth) continue;
      const background = behind(element);
      const [lighter, darker] = [
        luminance(over(rgba(getComputedStyle(element).color), background)),
        luminance(background),
      ].sort((a, b) => b - a) as [number, number];
      const ratio = (lighter + 0.05) / (darker + 0.05);
      if (ratio < 4.5) unreadable.push(`${ratio.toFixed(2)}:1 "${text.slice(0, 40)}"`);
    }
    return unreadable;
  });
}
