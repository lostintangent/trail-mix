import { afterAll, beforeAll, expect, test } from 'bun:test';
import { chromium, type Browser, type Page, type Route } from 'playwright';
import { startPreview, type Preview } from './preview.ts';

/**
 * Triage, end to end: the built app on workerd, with two browsers open on one member's demo mail.
 * The browser that acts shows the change at once, and the other shows it once the Mailroom's hint
 * reaches it. A fresh member each run starts from the seeded mailbox.
 */

const MEMBER = `triage-${Date.now()}@trailmix.test`;
const DESKTOP = { viewport: { width: 1440, height: 900 } };
/** How soon every other open browser shows a change, as the triage step promises. */
const ELSEWHERE_MS = 5_000;

let preview: Preview;
let browser: Browser;

beforeAll(async () => {
  preview = await startPreview({ DEV_MEMBER: MEMBER });
  browser = await chromium.launch();
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await preview?.stop();
});

/** A browser on the unified Inbox, once the Mailroom has filled it. */
async function inbox(): Promise<Page> {
  const page = await (await browser.newContext(DESKTOP)).newPage();
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
