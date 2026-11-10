import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { chromium, type Browser, type Page, type Route } from 'playwright';
import { startPreview, type Preview } from './preview.ts';

/**
 * Triage, end to end: the built app on workerd, with two browsers open on one member's demo mail.
 * The browser that acts shows the change at once, and the other shows it once the Mailroom's hint
 * reaches it. A fresh member each run starts from the seeded mailbox.
 */

const MEMBER = `triage-${Date.now()}@trailmix.test`;
const DESKTOP = { viewport: { width: 1440, height: 900 } };
const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true };
/** How soon every other open browser shows a change, as the triage step promises. */
const ELSEWHERE_MS = 5_000;

let preview: Preview;
let browser: Browser;

beforeAll(async () => {
  preview = await startPreview({ DEV_MEMBER: MEMBER });
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

/** A browser on the unified Inbox, once the Mailroom has filled it. */
async function inbox(size: typeof DESKTOP | typeof PHONE = DESKTOP): Promise<Page> {
  const page = await (await browser.newContext(size)).newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(preview.url);
  await page.getByText('Up to date').waitFor({ state: 'attached', timeout: 30_000 });
  return page;
}

/**
 * Holds every command this browser sends for a second, so what it shows before then can only be
 * its own doing, and the Mailroom's answer and hints come after. The release lets the held
 * commands through, then stops holding.
 */
async function slowCommands(page: Page): Promise<() => Promise<void>> {
  const held: Promise<void>[] = [];
  const hold = (route: Route) => {
    const through = (async () => {
      if (route.request().method() === 'POST') await new Promise((done) => setTimeout(done, 1_000));
      // A fetch the app gave up on meanwhile, as a superseded refetch is, is already handled.
      await route.continue().catch((error: unknown) => {
        if (!String(error).includes('already handled')) throw error;
      });
    })();
    held.push(through);
    return through;
  };
  await page.route('**/_serverFn/**', hold);
  return async () => {
    await Promise.all(held);
    await page.unroute('**/_serverFn/**', hold);
  };
}

/** A finger on the screen, through the browser's own touch input, as a phone's would come. */
async function finger(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  const touch = (type: 'touchStart' | 'touchMove' | 'touchEnd', x: number, y: number) =>
    cdp.send('Input.dispatchTouchEvent', {
      type,
      touchPoints: type === 'touchEnd' ? [] : [{ x, y }],
    });
  return {
    /** Holds a finger on a point for a while, then lifts it. */
    press: async (x: number, y: number, ms: number) => {
      await touch('touchStart', x, y);
      await page.waitForTimeout(ms);
      await touch('touchEnd', x, y);
    },
    /** Drags a finger left by some pixels, in steps, then lifts it. */
    swipeLeft: async (x: number, y: number, by: number) => {
      await touch('touchStart', x, y);
      for (let step = 1; step <= 6; step++) await touch('touchMove', x - (by * step) / 6, y);
      await touch('touchEnd', x - by, y);
    },
  };
}

/** The middle of a row's text, where a finger lands on it. */
async function centerOf(page: Page, at: number) {
  const box = (await page.getByRole('option').nth(at).boundingBox())!;
  return { x: box.x + box.width / 2, y: box.y + box.height / 2, width: box.width };
}

const row = (page: Page, subject: RegExp) => page.getByRole('option').filter({ hasText: subject });
const bar = (page: Page) => page.getByRole('toolbar', { name: 'Conversation' });

/**
 * Clicks one of the reader's actions and says how many milliseconds pass until the list, in a
 * painted frame, no longer holds the conversation.
 */
function msUntilGone(page: Page, action: string, subject: string): Promise<number> {
  return page.evaluate(
    ([action, subject]) =>
      new Promise<number>((resolve) => {
        const button = document.querySelector<HTMLElement>(
          `section[aria-label="Reader"] [role="toolbar"] button[aria-label="${action}"]`,
        )!;
        const isListed = () =>
          [...document.querySelectorAll('[role="option"]')].some((row) =>
            row.textContent?.includes(subject),
          );
        const start = performance.now();
        button.click();
        const check = () => {
          if (isListed()) requestAnimationFrame(check);
          else resolve(performance.now() - start);
        };
        requestAnimationFrame(check);
      }),
    [action, subject] as const,
  );
}

test('archiving shows at once, reaches another open browser, and Undo brings it back to both', async () => {
  const [here, there] = await Promise.all([inbox(), inbox()]);
  const subject = /Invoice for October/;
  await row(here, subject).click();
  await bar(here).getByRole('button', { name: 'Archive' }).waitFor();

  const release = await slowCommands(here);
  expect(await msUntilGone(here, 'Archive', 'Invoice for October')).toBeLessThan(50);
  await release();
  await row(there, subject).waitFor({ state: 'detached', timeout: ELSEWHERE_MS });

  await here.getByRole('button', { name: 'Undo' }).click();
  await row(here, subject).waitFor({ timeout: 1_000 });
  await row(there, subject).waitFor({ timeout: ELSEWHERE_MS });
}, 30_000);

test('a flag and a read mark show at once and in the other browser, and Undo takes them back', async () => {
  const [here, there] = await Promise.all([inbox(), inbox()]);
  const subject = /Lunch Thursday/;
  const flagged = (page: Page) => row(page, subject).getByRole('img', { name: 'Flagged' });
  await row(here, subject).click();

  const release = await slowCommands(here);
  await bar(here).getByRole('button', { name: 'Flag', exact: true }).click();
  await flagged(here).waitFor({ timeout: 500 });
  await release();
  await flagged(there).waitFor({ timeout: ELSEWHERE_MS });
  await here.getByRole('button', { name: 'Undo' }).click();
  await flagged(here).waitFor({ state: 'detached', timeout: 1_000 });
  await flagged(there).waitFor({ state: 'detached', timeout: ELSEWHERE_MS });

  const unread = (page: Page) => row(page, subject).getByText('Unread', { exact: true });
  await bar(here).getByRole('button', { name: 'More' }).click();
  await here.getByRole('menuitem', { name: 'Mark unread' }).click();
  await unread(here).waitFor({ state: 'attached', timeout: 1_000 });
  await unread(there).waitFor({ state: 'attached', timeout: ELSEWHERE_MS });
}, 30_000);

test('opening a conversation marks it read, here and in the other browser', async () => {
  const [here, there] = await Promise.all([inbox(), inbox()]);
  const subject = /Trip photos/;
  const unread = (page: Page) => row(page, subject).getByText('Unread', { exact: true });
  await unread(here).waitFor({ state: 'attached' });

  await row(here, subject).click();
  await unread(here).waitFor({ state: 'detached', timeout: 1_000 });
  await unread(there).waitFor({ state: 'detached', timeout: ELSEWHERE_MS });
}, 30_000);

test('a selection made with Cmd and Shift is archived together, and Undo brings it all back', async () => {
  const [here, there] = await Promise.all([inbox(), inbox()]);
  const options = here.getByRole('option');
  // A row is known by its subject and preview, which opening it to read doesn't change.
  const lines = (at: number) =>
    Promise.all(
      [2, 3].map((line) =>
        options
          .nth(at)
          .locator(`:scope > span:nth-child(2) > span:nth-child(${line})`)
          .textContent(),
      ),
    );
  const picked = await Promise.all([4, 5, 6].map(lines));
  const listed = (page: Page, [subject, preview]: (string | null)[]) =>
    page
      .getByRole('option')
      .filter({ hasText: subject ?? '' })
      .filter({ hasText: preview ?? '' });
  expect(await Promise.all(picked.map((text) => listed(here, text).count()))).toEqual([1, 1, 1]);
  await options.nth(4).click();
  await options.nth(6).click({ modifiers: ['Shift'] });
  await options.nth(5).click({ modifiers: ['ControlOrMeta'] });
  await here.getByRole('heading', { name: '2 conversations selected' }).waitFor();
  await options.nth(5).click({ modifiers: ['ControlOrMeta'] });
  await here.getByRole('heading', { name: '3 conversations selected' }).waitFor();

  const selection = here.getByRole('toolbar', { name: 'Selected conversations' });
  await selection.getByRole('button', { name: 'Archive' }).click();
  for (const text of picked) {
    await listed(here, text).waitFor({ state: 'detached', timeout: 1_000 });
    await listed(there, text).waitFor({ state: 'detached', timeout: ELSEWHERE_MS });
  }
  await here.getByRole('button', { name: 'Undo' }).click();
  for (const text of picked) await listed(there, text).waitFor({ timeout: ELSEWHERE_MS });
}, 30_000);

test('on a phone, a long press starts picking, a tap adds, and the island acts on what was picked', async () => {
  const here = await inbox(PHONE);
  const hand = await finger(here);
  const options = here.getByRole('option');
  const picked = await Promise.all([1, 2].map((at) => options.nth(at).textContent()));
  const first = await centerOf(here, 1);
  await hand.press(first.x, first.y, 700);
  const second = await centerOf(here, 2);
  await hand.press(second.x, second.y, 40);

  const island = here.getByRole('toolbar', { name: 'Picked conversations' });
  await expect(island.textContent()).resolves.toContain('2');
  // Picking keeps the list on screen rather than opening a conversation.
  await expect(options.nth(1).getAttribute('aria-selected')).resolves.toBe('true');
  await expect(options.nth(2).getAttribute('aria-selected')).resolves.toBe('true');

  await island.getByRole('button', { name: 'Archive' }).click();
  for (const text of picked) {
    await options.filter({ hasText: text ?? '' }).waitFor({ state: 'detached', timeout: 1_000 });
  }
  // With nothing picked, the island offers the folders again.
  await here.getByRole('button', { name: 'Folders', exact: true }).waitFor();
}, 30_000);

test('on a phone, a row swiped far enough left is archived, and a short swipe slides back', async () => {
  const here = await inbox(PHONE);
  const hand = await finger(here);
  const options = here.getByRole('option');

  const short = await options.nth(1).textContent();
  const one = await centerOf(here, 1);
  await hand.swipeLeft(one.x, one.y, one.width * 0.2);
  await here.waitForTimeout(400);
  await expect(options.nth(1).textContent()).resolves.toBe(short);
  // The short swipe neither archived nor opened the conversation.
  await expect(options.nth(1).getAttribute('aria-selected')).resolves.toBe('false');

  const far = await options.nth(2).textContent();
  const two = await centerOf(here, 2);
  await hand.swipeLeft(two.x, two.y, two.width * 0.6);
  await options.filter({ hasText: far ?? '' }).waitFor({ state: 'detached', timeout: 1_000 });
  await here.getByRole('button', { name: 'Undo' }).click();
  await options.filter({ hasText: far ?? '' }).waitFor({ timeout: ELSEWHERE_MS });
}, 30_000);
