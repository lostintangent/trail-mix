import { gzipSync } from 'node:zlib';
import { chromium, type Page } from 'playwright';
import { startPreview } from '../e2e/preview.ts';
import { percentile, type BenchArea, type Measurement } from './budget.ts';
import { phone, slowDown } from './phone.ts';
import { watch } from './steady.ts';

/**
 * The workbench's budgets, as AGENTS.md sets them: a cold load to the first Inbox rows, the
 * JavaScript that load needs, scrolling a 50,000-message folder, and moving through it by key. Each
 * runs on the built app with a 50,000-message demo mailbox, at the CPU of the phone in `phone.ts`.
 */
const BUDGET = { coldLoad: 1000, firstLoadJs: 250, scrollFrame: 1000 / 60, keyMove: 50 };

/** The built app's 50,000-message demo mailbox, as `DEMO_MAILBOX` fills it. */
const MESSAGES = '50000';

/**
 * A member of the bench's own. `DEMO_MAILBOX` sizes only a new Mailroom, and the preview keeps its
 * storage between runs, so the smoke suite's member already holds a smaller mailbox.
 */
const MEMBER = 'bench@trailmix.test';

/** A frame counts as on time within a millisecond of the 60Hz interval, for timer jitter. */
const FRAME_SLACK = 1;

export const workbench: BenchArea = {
  name: 'workbench',
  measure: async () => {
    const preview = await startPreview({ DEMO_MAILBOX: MESSAGES, DEV_MEMBER: MEMBER });
    const browser = await chromium.launch();
    try {
      // A first visit stays until the Mailroom has filled its demo accounts, so what follows measures
      // the browser starting cold on a full index, with no sync under way.
      const warm = await phone(browser);
      const filling = await warm.newPage();
      await filling.goto(preview.url);
      await filling.getByText('Up to date').waitFor({ state: 'attached', timeout: 180_000 });
      await warm.close();

      const context = await phone(browser);
      const page = await context.newPage();
      const phoneWatch = watch(page);
      await slowDown(page);
      const scripts: Promise<number>[] = [];
      page.on('response', (response) => {
        if (response.request().resourceType() === 'script') {
          scripts.push(response.body().then((body) => gzipSync(body).length / 1000));
        }
      });
      const coldLoad = await phoneWatch.during('Cold load', async () => {
        await page.goto(preview.url);
        return firstRows(page);
      });
      console.log('The cold load, step by step, in ms from navigation:');
      console.table(await coldLoadSteps(page));
      const firstLoadJs = (await Promise.all(scripts)).reduce((sum, size) => sum + size, 0);
      await phoneWatch.steady();
      const scrollFrame = percentile(
        await phoneWatch.during('Scrolling', () => scrollFrames(page)),
        0.95,
      );
      await context.close();

      // Keys move through the list on a desktop, where the list stays in view as its selection opens.
      const desktop = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      const desk = await desktop.newPage();
      const deskWatch = watch(desk);
      await slowDown(desk);
      await desk.goto(preview.url);
      await firstRows(desk);
      // The moves start from the first conversation, open, read and settled, so the read mark that
      // opening it sends lands before the moves are timed.
      await desk.getByRole('option').first().click();
      await deskWatch.steady();
      const keyMove = percentile(
        await deskWatch.during('Moving by key', () => keyMoves(desk)),
        0.95,
      );
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

/** Milliseconds from navigation until the first conversation row is on screen. */
async function firstRows(page: Page): Promise<number> {
  await page.waitForSelector('[role="option"]', { timeout: 30_000 });
  return page.evaluate(
    () => new Promise<number>((resolve) => requestAnimationFrame(() => resolve(performance.now()))),
  );
}

/**
 * Where the cold load's time went, from the page's own timings: the HTML, the scripts arriving, each
 * query to the Mailroom from start to end, and the first rows on screen.
 */
function coldLoadSteps(page: Page): Promise<{ step: string; start: number; end: number }[]> {
  return page.evaluate(() => {
    const at = (ms: number) => Math.round(ms);
    const [navigation] = performance.getEntriesByType(
      'navigation',
    ) as PerformanceNavigationTiming[];
    const resources = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
    const scripts = resources.filter(({ name }) => new URL(name).pathname.endsWith('.js'));
    const queries = resources.filter(({ name }) => name.includes('/_serverFn/'));
    return [
      { step: 'HTML', start: 0, end: at(navigation?.responseEnd ?? 0) },
      {
        step: 'Scripts',
        start: at(Math.min(...scripts.map(({ startTime }) => startTime))),
        end: at(Math.max(...scripts.map(({ responseEnd }) => responseEnd))),
      },
      ...queries.map(({ name, startTime, responseEnd }) => ({
        step: `Query ${/"s":"(\w+)"/.exec(new URL(name).searchParams.get('payload') ?? '')?.[1]}`,
        start: at(startTime),
        end: at(responseEnd),
      })),
      { step: 'First rows', start: at(performance.now()), end: at(performance.now()) },
    ];
  });
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
