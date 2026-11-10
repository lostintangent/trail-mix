import { gzipSync } from 'node:zlib';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { startPreview } from '../e2e/preview.ts';
import { percentile, type BenchArea, type Measurement } from './budget.ts';

/**
 * The workbench's budgets, as AGENTS.md sets them: a cold load to the first Inbox rows, the
 * JavaScript that load needs, scrolling a 50,000-message folder, and moving through it by key. Each
 * runs on the built app with a 50,000-message demo mailbox, on a phone profile at 4x CPU slowdown.
 */
const BUDGET = { coldLoad: 1000, firstLoadJs: 250, scrollFrame: 1000 / 60, keyMove: 50 };

/** The built app's 50,000-message demo mailbox, as `DEMO_MAILBOX` fills it. */
const MESSAGES = '50000';

/** A frame counts as on time within a millisecond of the 60Hz interval, for timer jitter. */
const FRAME_SLACK = 1;

export const workbench: BenchArea = {
  name: 'workbench',
  measure: async () => {
    const preview = await startPreview({ DEMO_MAILBOX: MESSAGES });
    const browser = await chromium.launch();
    try {
      // A first visit lets the Mailroom fill its demo account, so the cold load that follows measures
      // the browser starting cold rather than the first sync.
      const warm = await phone(browser);
      await (await warm.newPage()).goto(preview.url);
      await firstRows(warm.pages()[0]!);
      await warm.close();

      const context = await phone(browser);
      const page = await context.newPage();
      await slowDown(page);
      const scripts: Promise<number>[] = [];
      page.on('response', (response) => {
        if (response.request().resourceType() === 'script') {
          scripts.push(response.body().then((body) => gzipSync(body).length / 1000));
        }
      });
      await page.goto(preview.url);
      const coldLoad = await firstRows(page);
      const firstLoadJs = (await Promise.all(scripts)).reduce((sum, size) => sum + size, 0);
      const scrollFrame = percentile(await scrollFrames(page), 0.95);
      await context.close();

      // Keys move through the list on a desktop, where the list stays in view as its selection opens.
      const desktop = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      const desk = await desktop.newPage();
      await slowDown(desk);
      await desk.goto(preview.url);
      await firstRows(desk);
      const keyMove = percentile(await keyMoves(desk), 0.95);
      await desktop.close();

      return [
        measured('Cold load to the first Inbox rows', coldLoad, BUDGET.coldLoad, 'ms'),
        measured('First-load JavaScript, gzip', firstLoadJs, BUDGET.firstLoadJs, 'KB'),
        measured(
          'Scrolling 50,000 messages, p95 frame',
          scrollFrame,
          BUDGET.scrollFrame + FRAME_SLACK,
          'ms',
        ),
        measured('Moving through the list by key, p95', keyMove, BUDGET.keyMove, 'ms'),
      ];
    } finally {
      await browser.close();
      await preview.stop();
    }
  },
};

function measured(name: string, value: number, budget: number, unit: Measurement['unit']) {
  return { area: 'workbench', name, value, budget, unit };
}

function phone(browser: Browser): Promise<BrowserContext> {
  return browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 3,
  });
}

async function slowDown(page: Page): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
}

/** Milliseconds from navigation until the first conversation row is on screen. */
async function firstRows(page: Page): Promise<number> {
  await page.waitForSelector('[role="option"]', { timeout: 30_000 });
  return page.evaluate(
    () => new Promise<number>((resolve) => requestAnimationFrame(() => resolve(performance.now()))),
  );
}

/** The interval between each frame while the list scrolls 120 pixels a frame for three seconds. */
function scrollFrames(page: Page): Promise<number[]> {
  return page.evaluate(
    () =>
      new Promise<number[]>((resolve) => {
        const list = document.querySelector('[role="listbox"]')!;
        const intervals: number[] = [];
        let last = performance.now();
        const step = (now: number) => {
          intervals.push(now - last);
          last = now;
          list.scrollTop += 120;
          if (intervals.length < 180) requestAnimationFrame(step);
          else resolve(intervals.slice(5));
        };
        requestAnimationFrame(step);
      }),
  );
}

/** Milliseconds from each Down key until the frame after the list has moved its selection. */
async function keyMoves(page: Page): Promise<number[]> {
  await page.locator('[role="listbox"]').focus();
  const times: number[] = [];
  for (let press = 0; press < 40; press++) {
    times.push(
      await page.evaluate(
        () =>
          new Promise<number>((resolve) => {
            const start = performance.now();
            document
              .querySelector('[role="listbox"]')!
              .dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
            requestAnimationFrame(() => setTimeout(() => resolve(performance.now() - start)));
          }),
      ),
    );
  }
  return times;
}
