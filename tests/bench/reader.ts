import { chromium, type Page } from 'playwright';
import { startPreview } from '../e2e/preview.ts';
import { slowDown } from './phone.ts';
import { percentile, type BenchArea } from './budget.ts';

/**
 * The reader's budgets, as AGENTS.md sets them. Moving by key to a conversation whose newest
 * message is 300 KB of HTML renders within 200 ms, its body fetched and sanitized ahead while the
 * browser was idle. That move comes after a rest, which the reader follows at once. The repeats of
 * a key held down after it still move through the list within 50 ms, because the reader waits for
 * the selection to rest. It runs on the built app with a 50,000-message demo mailbox at the phone's
 * CPU, around the demo's Kernel Weekly, which is that newsletter.
 *
 * The first open of the same newsletter, cold, with nothing prepared, is printed beside them.
 */
const BUDGET = { preparedMove: 200, heldKey: 50 };

/** The workbench's bench member and mailbox, so a run of both fills the Mailroom once. */
const MEMBER = 'bench@trailmix.test';
const MESSAGES = '50000';

/** The newsletter's row in the unified Inbox. */
const NEWSLETTER = /Kernel Weekly/;

/** How long the browser is left idle before a move, to prepare the conversations beside it. */
const IDLE_MS = 3_000;

/** A keyboard's usual delay between pressing a key and its first repeat. */
const REPEAT_DELAY_MS = 500;

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

      // Cold: after the app has idled as long as the prepared case does, the newsletter opened by
      // a click, its body fetched and sanitized only then.
      const cold = await desktop(preview.url);
      await cold.waitForTimeout(IDLE_MS);
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

      // Held: a key pressed after a rest opens the newsletter at once, as the moves above measure.
      // Held down, it repeats after the keyboard's delay. That delay is a rest too, so the first
      // repeat opens the next conversation at once. The later repeats never let the selection
      // rest, so the reader shows nothing more until the key comes up.
      await page.waitForTimeout(IDLE_MS);
      await timed(page, () => press(page, 'ArrowDown'));
      // The list draws only the rows near the selection, so the next row is found by position.
      const next = await page.evaluate(() => {
        const selected = document.querySelector('[role="option"][aria-selected="true"]');
        const position = Number(selected?.getAttribute('aria-posinset')) + 1;
        return document.querySelector(`[role="option"][aria-posinset="${position}"]`)?.textContent;
      });
      await page.waitForTimeout(REPEAT_DELAY_MS);
      const held = await heldKey(page);
      await page.context().close();
      if (held.shown.length > 1 || !held.shown.every((subject) => next?.includes(subject))) {
        throw new Error(
          `While a key repeated, the reader showed ${held.shown.join(', ')}. The row after ` +
            `the newsletter was ${next?.slice(0, 80)}, and the longest repeat took ` +
            `${Math.max(...held.times).toFixed(0)} ms, against the reader's 150 ms rest.`,
        );
      }

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
        {
          area: 'reader',
          name: 'Holding a key with a conversation open, p95',
          value: percentile(held.times, 0.95),
          budget: BUDGET.heldKey,
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
      await slowDown(page);
      await page.goto(url);
      await page.waitForSelector('[role="option"]', { timeout: 30_000 });
      return page;
    }
  },
};

/**
 * Each of 40 repeats of a held key, timed until the frame after it is drawn, and the subjects of
 * the conversations the reader showed meanwhile.
 */
function heldKey(page: Page): Promise<{ times: number[]; shown: string[] }> {
  return page.evaluate(async () => {
    const list = document.querySelector('[role="listbox"]')!;
    const reader = document.querySelector('section[aria-label="Reader"]')!;
    const heading = () => reader.querySelector('h1')?.textContent ?? '';
    const before = heading();
    const shown: string[] = [];
    const observer = new MutationObserver(() => {
      const now = heading();
      if (now && now !== (shown.at(-1) ?? before)) shown.push(now);
    });
    observer.observe(reader, { subtree: true, childList: true, characterData: true });
    const times: number[] = [];
    for (let repeat = 0; repeat < 40; repeat++) {
      times.push(
        await new Promise<number>((resolve) => {
          const start = performance.now();
          list.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
          requestAnimationFrame(() => setTimeout(() => resolve(performance.now() - start)));
        }),
      );
    }
    observer.disconnect();
    return { times, shown };
  });
}

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
