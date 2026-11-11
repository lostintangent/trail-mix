import { gzipSync } from 'node:zlib';
import { chromium, type Page, type Response } from 'playwright';
import { startPreview } from '../e2e/preview.ts';
import { percentile, type BenchArea, type Measurement, type Slow } from './budget.ts';
import { phone, slowDown } from './phone.ts';
import { inputLatency, type InputLatency } from './latency.ts';
import { watch, type Watch } from './steady.ts';

/**
 * The workbench's budgets, as AGENTS.md sets them: a cold load to the first Inbox rows, the
 * JavaScript that load needs, scrolling a 50,000-message folder, moving through it by key, and
 * archiving the conversation open in the reader, and search showing its matches as it is typed.
 * Each runs on the built app with a 50,000-message demo mailbox, at the CPU of the phone in
 * `phone.ts`.
 */
const BUDGET = {
  coldLoad: 1000,
  firstLoadJs: 250,
  scrollFrame: 1000 / 60,
  keyMove: 50,
  archive: 50,
  search: 100,
};

/**
 * What a member types into search, a keystroke at a time, as the Mailroom's bench types it: a
 * sender's name, a newsletter's, and a word nearly every message holds.
 */
const TYPED = ['mina okafor', 'kernel weekly', 'are'];

/** The built app's 50,000-message demo mailbox, as `DEMO_MAILBOX` fills it. */
const MESSAGES = '50000';

/**
 * A member of the bench's own. `DEMO_MAILBOX` sizes only a new Mailroom, and the preview keeps its
 * storage between runs, so the smoke suite's member already holds a smaller mailbox.
 */
const MEMBER = 'bench@trailmix.test';

/** A frame counts as on time within a millisecond of the 60Hz interval, for timer jitter. */
const FRAME_SLACK = 1;

/**
 * How many times a key is held and the searches are typed, each from a fresh page, pooled into one
 * p95. With one round, a p95 is the second-slowest of a few dozen inputs, so one slow frame decides
 * it. Every input of every round counts, so a round can't be dropped, and a real regression moves
 * them all.
 */
const ROUNDS = 5;

/** How many conversations are archived in a row. */
const ARCHIVES = 60;

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
      const sized = (response: Response) => {
        if (response.request().resourceType() === 'script') {
          scripts.push(response.body().then((body) => gzipSync(body).length / 1000));
        }
      };
      page.on('response', sized);
      const coldLoad = await phoneWatch.during('Cold load', async () => {
        await page.goto(preview.url);
        return firstRows(page);
      });
      console.log('The cold load, step by step, in ms from navigation:');
      console.table(await coldLoadSteps(page));
      // Only the cold load's scripts count. A reload revalidates them, and a 304 has no body.
      page.off('response', sized);
      const firstLoadJs = (await Promise.all(scripts)).reduce((sum, size) => sum + size, 0);
      await phoneWatch.steady();
      const scrollFrame = percentile(
        await phoneWatch.during('Scrolling', () => scrollFrames(page)),
        0.95,
      );
      const typed: Typed[] = [];
      for (let round = 1; round <= ROUNDS; round++) {
        if (round > 1) {
          await page.reload();
          await firstRows(page);
        }
        await phoneWatch.steady();
        typed.push(
          ...(await phoneWatch.during(`Searching as it is typed, round ${round}`, () =>
            searchKeystrokes(page),
          )),
        );
      }
      const search = percentile(
        typed.map(({ latency }) => latency),
        0.95,
      );
      const searchSlowest = await (await inputLatency(page)).slowestSpans(typed);
      await context.close();

      // Keys move through the list on a desktop, where the list stays in view as its selection opens.
      const desktop = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      const desk = await desktop.newPage();
      const deskWatch = watch(desk);
      await slowDown(desk);
      await desk.goto(preview.url);
      await firstRows(desk);
      const moves: number[] = [];
      const keySlowest: Slow[] = [];
      let latency: InputLatency | undefined;
      for (let round = 1; round <= ROUNDS; round++) {
        if (round > 1) {
          await desk.reload();
          await firstRows(desk);
        }
        const timing = await inputLatency(desk);
        latency = timing;
        // The moves start from the first conversation, open, read and settled, so the read mark that
        // opening it sends lands before the moves are timed.
        await desk.getByRole('option').first().click();
        await deskWatch.steady();
        const keys = await deskWatch.during(`Moving by key, round ${round}`, () =>
          keyMoves(desk, timing),
        );
        moves.push(...keys.latencies);
        keySlowest.push(...(await timing.slowest('keydown', keys.timestamps)));
      }
      const keyMove = percentile(moves, 0.95);
      const archive = percentile(await archives(desk, deskWatch, latency!), 0.95);
      const archiveSlowest = await latency!.slowestOf('click');
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
        measured('Moving through the list by key, p95', keyMove, BUDGET.keyMove, 'ms', keySlowest),
        measured('Archiving, p95', archive, BUDGET.archive, 'ms', archiveSlowest),
        measured(
          'Search showing matches as it is typed, p95',
          search,
          BUDGET.search,
          'ms',
          searchSlowest,
        ),
      ];
    } finally {
      await browser.close();
      await preview.stop();
    }
  },
};

function measured(
  name: string,
  value: number,
  budget: number,
  unit: Measurement['unit'],
  slowest?: Slow[],
): Measurement {
  const worst = slowest?.toSorted((a, b) => b.latency - a.latency).slice(0, 5);
  return { area: 'workbench', name, value, budget, unit, ...(worst && { slowest: worst }) };
}

/**
 * Each keystroke of the typed searches, timed from the key going down until the list holding the
 * matches for everything typed so far has painted.
 */
type Typed = { start: number; latency: number };

async function searchKeystrokes(page: Page): Promise<Typed[]> {
  const field = page.getByRole('searchbox', { name: 'Search mail' });
  const times: Typed[] = [];
  for (const text of TYPED) {
    await field.fill('');
    await page.getByRole('heading', { name: 'Inbox', level: 2 }).waitFor();
    await field.focus();
    for (let typed = 1; typed <= text.length; typed++) {
      await page.evaluate(() => {
        document.addEventListener(
          'keydown',
          (event) => {
            (window as unknown as { pressedAt: number }).pressedAt = event.timeStamp;
          },
          { capture: true, once: true },
        );
      });
      await page.keyboard.type(text.charAt(typed - 1));
      times.push(await page.evaluate(matched, text.slice(0, typed)));
    }
  }
  return times;
}

/**
 * In the page: milliseconds from the key going down until the frame that draws the list holding
 * `text`'s matches has painted. The list is checked as each frame begins, and a task queued then
 * runs once that frame has painted.
 */
function matched(text: string): Promise<{ start: number; latency: number }> {
  return new Promise((resolve) => {
    const check = () => {
      const field = document.querySelector<HTMLInputElement>('input[type="search"]');
      // The conversation list, and not the palette's commands, which can show as the field is typed in.
      const list = document.querySelector('[role="listbox"][aria-busy]');
      if (field?.value === text && list?.getAttribute('aria-busy') === 'false') {
        setTimeout(() => {
          const start = (window as unknown as { pressedAt: number }).pressedAt;
          resolve({ start, latency: performance.now() - start });
        });
      } else requestAnimationFrame(check);
    };
    requestAnimationFrame(check);
  });
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

/** How often a held key repeats, as a keyboard does after its first delay. */
const KEY_REPEAT_MS = 33;
const REPEATS = 40;

/**
 * The latency of each Down key while one is held, 40 repeats at a keyboard's pace, from each key's
 * timestamp to the next frame painted. Each key carries the timestamp a keyboard would give it, so
 * a slow frame shows as latency here, and never as a pause the reader would take for a rest. It
 * fails unless the keys reached the list a repeat apart and the reader opened only the first and
 * the last conversation, since anything else measured something other than a held key.
 */
async function keyMoves(
  page: Page,
  latency: InputLatency,
): Promise<{ latencies: number[]; timestamps: number[] }> {
  await page.locator('[role="listbox"]').focus();
  await page.evaluate(() => {
    const seen = { keys: [] as number[], opened: [] as string[] };
    (window as unknown as { seen: typeof seen }).seen = seen;
    addEventListener('keydown', (event) => seen.keys.push(event.timeStamp), true);
    const reader = document.querySelector('section[aria-label="Reader"]')!;
    new MutationObserver(() => {
      const title = reader.querySelector('h1')?.textContent;
      if (title && title !== seen.opened.at(-1)) seen.opened.push(title);
    }).observe(reader, { subtree: true, childList: true, characterData: true });
  });
  const keys = await page.context().newCDPSession(page);
  const key = { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 };
  const start = Date.now() / 1000;
  const sent: Promise<unknown>[] = [];
  for (let repeat = 0; repeat < REPEATS; repeat++) {
    // Each key goes when its timestamp says, by the clock, so the sending never drifts behind them.
    const timestamp = start + (repeat * KEY_REPEAT_MS) / 1000;
    await new Promise((done) => setTimeout(done, Math.max(0, timestamp * 1000 - Date.now())));
    const autoRepeat = repeat > 0;
    sent.push(
      keys.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', timestamp, autoRepeat, ...key }),
    );
  }
  sent.push(keys.send('Input.dispatchKeyEvent', { type: 'keyUp', ...key }));
  await Promise.all(sent);
  await page.waitForTimeout(1_000);

  const seen = await page.evaluate(
    () => (window as unknown as { seen: { keys: number[]; opened: string[] } }).seen,
  );
  const gaps = seen.keys.slice(1).map((at, index) => at - seen.keys[index]!);
  const gap = percentile(gaps, 0.5);
  if (seen.keys.length !== REPEATS || Math.abs(gap - KEY_REPEAT_MS) > 5) {
    throw new Error(`The list saw ${seen.keys.length} keys, a median ${gap.toFixed(1)} ms apart.`);
  }
  // Before the keys, the first conversation was open. The first key rests and opens the next, and
  // the last opens once the keys stop. A conversation between them means a key was taken for a rest.
  if (seen.opened.length > 2) {
    throw new Error(`The reader opened ${seen.opened.length} conversations while a key was held.`);
  }
  // Each key by the page's own record of it, since its timestamp comes from this process's clock.
  return { latencies: await latency.at('keydown', seen.keys), timestamps: seen.keys };
}

/**
 * The latency of each click on Archive at the head of the list, from the click to the next frame
 * painted. Each archive opens the next conversation, which is archived next once the reader shows it
 * and the last one's hints and read mark have landed.
 */
async function archives(page: Page, watching: Watch, latency: InputLatency): Promise<number[]> {
  const archive = page
    .getByRole('toolbar', { name: 'Conversation' })
    .getByRole('button', { name: 'Archive' });
  await page.getByRole('option').nth(2).click();
  const times: number[] = [];
  for (let press = 0; press < ARCHIVES; press++) {
    await archive.waitFor();
    // The reader follows a selection once it rests, so wait until it shows the selected one.
    await page.waitForFunction(() => {
      const title = document.querySelector('section[aria-label="Reader"] h1')?.textContent;
      const row = document.querySelector('[role="option"][aria-selected="true"]')?.textContent;
      return Boolean(title && row?.includes(title));
    });
    await watching.steady();
    const since = await latency.now();
    await watching.during(`Archive ${press + 1}`, () => archive.click());
    await page.waitForTimeout(200);
    const [down, up, click] = await Promise.all(
      ['pointerdown', 'pointerup', 'click'].map((name) => latency.of(name, since, 1)),
    );
    times.push(Math.max(...down!, ...up!, ...click!));
  }
  return times;
}
