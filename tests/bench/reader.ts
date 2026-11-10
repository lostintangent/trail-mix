import { chromium, type Page } from 'playwright';
import { startPreview } from '../e2e/preview.ts';
import { percentile, type BenchArea } from './budget.ts';

/**
 * The reader's budget, as AGENTS.md sets it: moving by key to a conversation whose newest message
 * is 300 KB of HTML renders within 200 ms, its body fetched and sanitized ahead while the browser
 * was idle. It runs on the built app with a 50,000-message demo mailbox at 4x CPU slowdown, and
 * moves onto the demo's Kernel Weekly, which is that newsletter.
 *
 * The first open of the same newsletter, cold, with nothing prepared, is printed beside it.
 */
const BUDGET = { preparedMove: 200 };

/** The workbench's bench member and mailbox, so a run of both fills the Mailroom once. */
const MEMBER = 'bench@trailmix.test';
const MESSAGES = '50000';

/** The newsletter's row in the unified Inbox. */
const NEWSLETTER = /Kernel Weekly/;

/** How long the browser is left idle after a selection, to prepare the conversations beside it. */
const IDLE_MS = 3_000;

export const reader: BenchArea = {
  name: 'reader',
  measure: async () => {
    const preview = await startPreview({ DEMO_MAILBOX: MESSAGES, DEV_MEMBER: MEMBER });
    const browser = await chromium.launch();
    try {
      const filling = await browser.newPage();
      await filling.goto(preview.url);
      await filling.getByText('Up to date').waitFor({ state: 'attached', timeout: 180_000 });
      await filling.close();

      // Cold: the newsletter opened by a click, its body fetched and sanitized only then.
      const cold = await desktop(preview.url);
      const coldOpen = await timed(cold, () =>
        cold.getByRole('option').filter({ hasText: NEWSLETTER }).first().click(),
      );
      await cold.context().close();

      // Prepared: the conversation above the newsletter is open, the browser idles, then Down.
      const page = await desktop(preview.url);
      const rows = page.getByRole('option');
      const at = await rows.evaluateAll(
        (options, name) =>
          options.findIndex((option) => new RegExp(name).test(option.textContent ?? '')),
        NEWSLETTER.source,
      );
      await rows.nth(at - 1).click();
      await page.waitForTimeout(IDLE_MS);
      const moves: number[] = [];
      for (let round = 0; round < 5; round++) {
        moves.push(await timed(page, () => press(page, 'ArrowDown')));
        await press(page, 'ArrowUp');
        await page.waitForTimeout(IDLE_MS / 3);
      }
      await page.context().close();

      console.log(
        `reader: the first open of the 300 KB newsletter, cold, took ${coldOpen.toFixed(0)} ms`,
      );
      return [
        {
          area: 'reader',
          name: 'Moving to a prepared 300 KB conversation, p95',
          value: percentile(moves, 0.95),
          budget: BUDGET.preparedMove,
          unit: 'ms',
        },
      ];
    } finally {
      await browser.close();
      await preview.stop();
    }

    /** The app on a desktop, where the list stays in view as its selection opens, slowed down. */
    async function desktop(url: string): Promise<Page> {
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      const page = await context.newPage();
      const cdp = await context.newCDPSession(page);
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
      await page.goto(url);
      await page.waitForSelector('[role="option"]', { timeout: 30_000 });
      return page;
    }
  },
};

/** Moves the list's selection by a key, as the member would. */
function press(page: Page, key: 'ArrowDown' | 'ArrowUp'): Promise<void> {
  return page.evaluate((key) => {
    document
      .querySelector('[role="listbox"]')!
      .dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
  }, key);
}

/** Milliseconds from an action until the newsletter's frame is drawn, sized and visible. */
async function timed(page: Page, act: () => Promise<unknown>): Promise<number> {
  await page.evaluate(() => {
    (window as unknown as { benchStart: number }).benchStart = performance.now();
  });
  await act();
  return page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        const check = () => {
          const frame = document.querySelector<HTMLIFrameElement>(
            'section[aria-label="Reader"] iframe[title="Message from Kernel Weekly"]',
          );
          if (frame?.style.visibility === 'visible') {
            requestAnimationFrame(() =>
              resolve(performance.now() - (window as unknown as { benchStart: number }).benchStart),
            );
          } else requestAnimationFrame(check);
        };
        check();
      }),
  );
}
