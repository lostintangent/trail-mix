import { availableParallelism, cpus } from 'node:os';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';

/**
 * The phone the browser budgets are measured on: four times slower than the reference desktop. A
 * fixed 4x slowdown on a slower machine, like a CI runner, would emulate a slower phone than that,
 * so each run measures its machine's CPU and scales the slowdown to match.
 *
 * It measures with work shaped like what the budgets time, since machines don't rank the same on
 * every kind of work. A benchmark of tight script loops, such as Lighthouse's, rates the server
 * cores CI runs on higher, beside the reference desktop, than style, layout and rendering bear out,
 * so it emulated a phone up to 1.7 times slower than this one, by how much depending on the runner.
 */

/** What the phone is, beside the reference desktop. */
const PHONE_SLOWDOWN = 4;

/**
 * The reference desktop's `workloadIndex`: the Apple M4 Pro the budgets were set on, as the highest
 * of three runs after `warmUp`, ten times over (953 to 982). A run there throttles at about 4x.
 */
const REFERENCE_INDEX = 970;

export type CpuProfile = { index: number; rate: number };

/** The slowdown that makes this machine the phone, once `calibrate` has measured it. */
let calibrated: number | undefined;

/**
 * Measures this machine's workload index and the slowdown that makes it the phone, before a bench
 * starts anything else, such as the Workers runtime, a preview server or the browser it drives, so
 * the benchmark sees the machine quiet. It prints them above the budgets. It is the highest of three
 * runs, since whatever else the machine is doing can only lower a run, so a low one says the
 * machine was busy, not that it is slower.
 */
export async function calibrate(): Promise<CpuProfile> {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.evaluate(warmUp);
    const runs: number[] = [];
    for (let run = 0; run < 3; run++) runs.push(await page.evaluate(workloadIndex));
    const index = Math.max(...runs);
    const rate = Math.max(1, (PHONE_SLOWDOWN * index) / REFERENCE_INDEX);
    const [cpu] = cpus();
    console.log(
      `CPU: ${cpu?.model.trim() ?? 'unknown'}, ${availableParallelism()} cores. Workload index ${index} (${runs.join(', ')}), so the phone runs at ${rate.toFixed(2)}x slowdown.`,
    );
    calibrated = rate;
    return { index, rate };
  } finally {
    await browser.close();
  }
}

/** A page slowed down to the phone's CPU. */
export async function slowDown(page: Page): Promise<void> {
  if (calibrated === undefined)
    throw new Error('A page is slowed down only once the phone is calibrated.');
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: calibrated });
}

/** A phone's screen: its size, its touch and its pixel density. */
export function phone(browser: Browser): Promise<BrowserContext> {
  return browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 3,
  });
}

/**
 * Grows the page's young generation, as a page that has run for a while has grown it, so the
 * workload's allocations are collected about as often as the app's are. In a fresh page the
 * workload reads about 7% lower on the reference desktop. It runs in the page, so it must stay
 * self-contained.
 */
function warmUp(): void {
  const start = performance.now();
  while (performance.now() - start < 1_500) {
    let text = '';
    for (let i = 0; i < 10_000; i++) text += 'a';
    if (text.length === 1)
      throw new Error('Never, but it keeps the loop from being optimized away');
  }
}

/**
 * A workload shaped like what the budgets time: a list's rows built from their data, styled and laid
 * out, changed and laid out again, then taken down, as passes a second over half a second. It runs
 * in the page, so it must stay self-contained.
 */
function workloadIndex(): number {
  const style = document.createElement('style');
  style.textContent = [
    '.rows { display: flex; flex-direction: column; width: 390px; font: 15px system-ui }',
    '.row { display: grid; grid-template-columns: 32px 1fr auto; gap: 2px 8px; padding: 8px 12px; border-radius: 8px }',
    '.row.unread .who { font-weight: 600 }',
    '.who, .what { overflow: hidden; white-space: nowrap; text-overflow: ellipsis }',
    '.what { grid-column: 2 / 4 }',
    '.when { color: gray; font-size: 13px }',
  ].join('\n');
  document.head.append(style);
  const messages = Array.from({ length: 50 }, (_, i) => ({
    from: `Sender number ${i}`,
    subject: `The subject of message ${i}, about the plan for the week`,
    date: (i * 7919) % 1000,
    isUnread: i % 3 === 0,
  }));
  const start = performance.now();
  let passes = 0;
  while (performance.now() - start < 500) {
    const sorted = (JSON.parse(JSON.stringify(messages)) as typeof messages).sort(
      (a, b) => b.date - a.date,
    );
    const rows = document.createElement('div');
    rows.className = 'rows';
    for (const { from, subject, date, isUnread } of sorted) {
      const row = document.createElement('div');
      row.className = isUnread ? 'row unread' : 'row';
      for (const [name, text] of [
        ['face', from.slice(0, 2)],
        ['who', from],
        ['when', String(date)],
        ['what', subject],
      ] as const) {
        const span = document.createElement('span');
        span.className = name;
        span.textContent = text;
        row.append(span);
      }
      rows.append(row);
    }
    document.body.append(rows);
    void rows.offsetHeight;
    for (const row of rows.children) row.classList.toggle('unread');
    void rows.offsetHeight;
    rows.remove();
    passes++;
  }
  style.remove();
  return Math.round(passes / ((performance.now() - start) / 1000));
}
