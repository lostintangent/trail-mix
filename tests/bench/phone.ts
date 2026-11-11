import { availableParallelism, cpus } from 'node:os';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';

/**
 * The phone the browser budgets are measured on: four times slower than the reference desktop. A
 * fixed 4x slowdown on a slower machine, like a CI runner, would emulate a slower phone than that,
 * so each run measures its machine's CPU and scales the slowdown to match, as Lighthouse advises.
 */

/** What the phone is, beside the reference desktop. */
const PHONE_SLOWDOWN = 4;

/**
 * The reference desktop's benchmark index: the Apple M4 Pro the budgets were set on, as the highest
 * of three runs of `benchmarkIndex` below, three times over (4,358, 4,268 and 4,262). A run there
 * throttles at about 4x.
 */
const REFERENCE_INDEX = 4_270;

/**
 * The reference desktop's `workloadIndex`, as the highest of three runs, ten times over (962 to
 * 976). It is printed beside the benchmark index, which sets the slowdown, so each runner's two can
 * be compared before either replaces the other.
 */
const REFERENCE_WORKLOAD = 970;

export type CpuProfile = { index: number; rate: number };

let measured: Promise<CpuProfile> | undefined;

/**
 * This machine's benchmark index and the slowdown that makes it the phone, measured once a run
 * with nothing throttled and printed above the budgets. It is the highest of three runs, since
 * whatever else the machine is doing can only lower a run, so a low one says the machine was busy,
 * not that it is slower.
 */
export function cpuProfile(browser: Browser): Promise<CpuProfile> {
  measured ??= (async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    const runs: number[] = [];
    for (let run = 0; run < 3; run++) runs.push(await page.evaluate(benchmarkIndex));
    const workloads: number[] = [];
    for (let run = 0; run < 3; run++) workloads.push(await page.evaluate(workloadIndex));
    await context.close();
    const index = Math.max(...runs);
    const rate = Math.max(1, (PHONE_SLOWDOWN * index) / REFERENCE_INDEX);
    const workload = Math.max(...workloads);
    const workloadRate = Math.max(1, (PHONE_SLOWDOWN * workload) / REFERENCE_WORKLOAD);
    const [cpu] = cpus();
    console.log(
      `CPU: ${cpu?.model.trim() ?? 'unknown'}, ${availableParallelism()} cores. Benchmark index ${Math.round(index)} (${runs.map(Math.round).join(', ')}), so the phone runs at ${rate.toFixed(2)}x slowdown.`,
    );
    console.log(
      `Workload index ${workload} (${workloads.join(', ')}), which would run the phone at ${workloadRate.toFixed(2)}x.`,
    );
    return { index, rate };
  })();
  return measured;
}

/**
 * Measures this machine before a bench starts anything else, such as the Workers runtime, a preview
 * server or the browser it drives, so the benchmark sees the machine quiet. Later calls reuse it.
 */
export async function calibrate(): Promise<CpuProfile> {
  const browser = await chromium.launch();
  try {
    return await cpuProfile(browser);
  } finally {
    await browser.close();
  }
}

/** A page slowed down to the phone's CPU. */
export async function slowDown(page: Page): Promise<void> {
  const { rate } = await cpuProfile(page.context().browser()!);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate });
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
 * Lighthouse's CPU benchmark index, as `computeBenchmarkIndex` in its page functions computes it:
 * the mean of a garbage-heavy string build and a garbage-free array copy, each run for half a
 * second and counted per second over ten. It runs in the page, so it must stay self-contained.
 *
 * Copyright 2017 The Lighthouse Authors
 * SPDX-License-Identifier: Apache-2.0
 */
function benchmarkIndex(): number {
  function benchmarkIndexGC() {
    const start = Date.now();
    let iterations = 0;
    while (Date.now() - start < 500) {
      let s = '';
      for (let j = 0; j < 10000; j++) s += 'a';
      if (s.length === 1) throw new Error('Never, but it keeps the loop from being optimized away');
      iterations++;
    }
    return Math.round(iterations / 10 / ((Date.now() - start) / 1000));
  }

  function benchmarkIndexNoGC() {
    const arrA: number[] = [];
    const arrB: number[] = [];
    for (let i = 0; i < 100000; i++) arrA[i] = arrB[i] = i;
    const start = Date.now();
    let iterations = 0;
    // Date.now is read every tenth pass, which avoids a JCC alignment cliff on some Intel CPUs.
    while (iterations % 10 !== 0 || Date.now() - start < 500) {
      const src = iterations % 2 === 0 ? arrA : arrB;
      const tgt = iterations % 2 === 0 ? arrB : arrA;
      for (let j = 0; j < src.length; j++) tgt[j] = src[j]!;
      iterations++;
    }
    return Math.round(iterations / 10 / ((Date.now() - start) / 1000));
  }

  return (benchmarkIndexGC() + benchmarkIndexNoGC()) / 2;
}

/**
 * A workload shaped like what the budgets time, to calibrate by in place of the benchmark index if
 * it tracks machines better: a list's rows built from their data, styled and laid out, changed and
 * laid out again, then taken down, as passes a second over half a second. It runs in the page, so
 * it must stay self-contained.
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
