import { availableParallelism, cpus } from 'node:os';
import type { Browser, BrowserContext, Page } from 'playwright';

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
    await context.close();
    const index = Math.max(...runs);
    const rate = Math.max(1, (PHONE_SLOWDOWN * index) / REFERENCE_INDEX);
    const [cpu] = cpus();
    console.log(
      `CPU: ${cpu?.model.trim() ?? 'unknown'}, ${availableParallelism()} cores. Benchmark index ${Math.round(index)} (${runs.map(Math.round).join(', ')}), so the phone runs at ${rate.toFixed(2)}x slowdown.`,
    );
    return { index, rate };
  })();
  return measured;
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
