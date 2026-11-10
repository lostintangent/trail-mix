import type { Page } from 'playwright';

/** Event Timing reports only an input that took this long or longer, so a faster one counts as this. */
const REPORTED_FROM = 16;

type Timed = { name: string; start: number; duration: number };

/**
 * The latency of a page's inputs as the browser times them with Event Timing: from each input's own
 * timestamp until the next frame painted after it was handled. An input that waited behind other
 * work counts that wait too, as a member would feel it.
 */
export async function inputLatency(page: Page) {
  await page.evaluate((from) => {
    const timed: Timed[] = [];
    (window as unknown as { timed: Timed[] }).timed = timed;
    new PerformanceObserver((list) => {
      for (const { name, startTime, duration } of list.getEntries()) {
        timed.push({ name, start: startTime, duration });
      }
    }).observe({ type: 'event', durationThreshold: from } as PerformanceObserverInit);
  }, REPORTED_FROM);
  return {
    now: () => page.evaluate(() => performance.now()),
    /**
     * The latency of each of `count` inputs named `name` since a moment on the page's clock. Event
     * Timing reports an input once its frame has painted, so ask a moment after the last one.
     */
    of: async (name: string, since: number, count: number): Promise<number[]> => {
      const reported = await page.evaluate(
        ([name, since]) =>
          (window as unknown as { timed: Timed[] }).timed
            .filter((entry) => entry.name === name && entry.start >= since)
            .map(({ duration }) => duration),
        [name, since] as const,
      );
      return [
        ...reported,
        ...Array<number>(Math.max(0, count - reported.length)).fill(REPORTED_FROM),
      ];
    },
  };
}

export type InputLatency = Awaited<ReturnType<typeof inputLatency>>;
