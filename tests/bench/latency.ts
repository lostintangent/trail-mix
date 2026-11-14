import type { Page } from 'playwright';
import type { Ask, Slow } from './budget.ts';

/** Event Timing reports only an input that took this long or longer, so a faster one counts as this. */
const REPORTED_FROM = 16;

/** How near an entry's start must be to an input's timestamp to be that input's, well under a key repeat. */
const SAME_INPUT_MS = 1;

type Timed = {
  name: string;
  start: number;
  duration: number;
  processingStart: number;
  processingEnd: number;
};

/** A frame that took longer than 50 ms, and the scripts that ran in it. */
type LongFrame = { start: number; end: number; scripts: { name: string; duration: number }[] };

/**
 * The latency of a page's inputs as the browser times them with Event Timing: from each input's own
 * timestamp until the next frame painted after it was handled. An input that waited behind other
 * work counts that wait too, as a member would feel it.
 */
export async function inputLatency(page: Page) {
  await page.evaluate((from) => {
    // Enough for a round's every ask, past the default of 250, after which the browser keeps none.
    performance.setResourceTimingBufferSize(2_000);
    const timed: Timed[] = [];
    const frames: LongFrame[] = [];
    Object.assign(window, { timed, frames });
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries() as PerformanceEventTiming[]) {
        const { name, startTime, duration, processingStart, processingEnd } = entry;
        timed.push({ name, start: startTime, duration, processingStart, processingEnd });
      }
    }).observe({ type: 'event', durationThreshold: from } as PerformanceObserverInit);
    type Script = {
      invoker: string;
      sourceFunctionName: string;
      sourceURL: string;
      duration: number;
    };
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const scripts = ((entry as unknown as { scripts: Script[] }).scripts ?? []).map(
          ({ invoker, sourceFunctionName, sourceURL, duration }) => ({
            name: `${invoker} ${sourceFunctionName || '(anonymous)'} ${sourceURL.split('/').pop() ?? ''}`.trim(),
            duration: Math.round(duration),
          }),
        );
        frames.push({ start: entry.startTime, end: entry.startTime + entry.duration, scripts });
      }
    }).observe({ type: 'long-animation-frame', buffered: true });
  }, REPORTED_FROM);
  /**
   * The `count` slowest of the inputs named `name` at these timestamps, each split into the wait
   * before its handlers ran, the handlers and the wait for the frame, with the scripts that ran
   * longest in the long frames it spanned.
   */
  const slowest = async (
    name: string,
    timestamps: readonly number[],
    count = 5,
  ): Promise<Slow[]> => {
    const { timed, frames } = await page.evaluate(() => {
      const { timed, frames } = window as unknown as { timed: Timed[]; frames: LongFrame[] };
      return { timed, frames };
    });
    return timestamps
      .flatMap((at, nth) =>
        timed
          .filter((entry) => entry.name === name && Math.abs(entry.start - at) < SAME_INPUT_MS)
          .map((entry) => ({ ...entry, nth })),
      )
      .toSorted((a, b) => b.duration - a.duration)
      .slice(0, count)
      .map((entry) => ({
        latency: entry.duration,
        nth: entry.nth,
        inputDelay: Math.round(entry.processingStart - entry.start),
        processing: Math.round(entry.processingEnd - entry.processingStart),
        presentation: Math.round(entry.start + entry.duration - entry.processingEnd),
        scripts: scriptsDuring(frames, entry.start, entry.start + entry.duration),
      }));
  };

  return {
    now: () => page.evaluate(() => performance.now()),
    /**
     * The latency of the slowest input named `name` since a moment on the page's clock. Event Timing
     * reports an input once its frame has painted, so ask a moment after it.
     */
    of: async (name: string, since: number): Promise<number> => {
      const reported = await page.evaluate(
        ([name, since]) =>
          (window as unknown as { timed: Timed[] }).timed
            .filter((entry) => entry.name === name && entry.start >= since)
            .map(({ duration }) => duration),
        [name, since] as const,
      );
      return Math.max(REPORTED_FROM, ...reported);
    },
    /**
     * The latency of each input named `name` that the page saw at these timestamps, by its own
     * record of each. Every one counts, even one whose timestamp, given from another clock, falls
     * before a moment the page took earlier.
     */
    at: async (name: string, timestamps: readonly number[]): Promise<number[]> => {
      const reported = await page.evaluate(
        (name) =>
          (window as unknown as { timed: Timed[] }).timed.filter((entry) => entry.name === name),
        name,
      );
      return timestamps.map(
        (at) =>
          reported.find(({ start }) => Math.abs(start - at) < SAME_INPUT_MS)?.duration ??
          REPORTED_FROM,
      );
    },
    slowest,
    /** The `count` slowest inputs named `name` the page has seen, split as `slowest` splits them. */
    slowestOf: async (name: string, count = 5): Promise<Slow[]> => {
      const starts = await page.evaluate(
        (name) =>
          (window as unknown as { timed: Timed[] }).timed
            .filter((entry) => entry.name === name)
            .map(({ start }) => start),
        name,
      );
      return slowest(name, starts, count);
    },
    /**
     * The slowest of these spans on this page, such as a keystroke until its matches painted, with
     * the asks of the Mailroom that went during each and the long frames' scripts.
     */
    slowestSpans: async (
      spans: readonly { start: number; latency: number }[],
      count = 5,
    ): Promise<Slow[]> => {
      const { frames, asks } = await page.evaluate(() => ({
        frames: (window as unknown as { frames: LongFrame[] }).frames,
        asks: (performance.getEntriesByType('resource') as PerformanceResourceTiming[])
          .filter(({ name }) => name.includes('/_serverFn/'))
          .map(({ name, startTime, responseEnd, serverTiming }) => ({
            name:
              /"s":"(\w+)"/.exec(new URL(name).searchParams.get('payload') ?? '')?.[1] ?? 'command',
            start: startTime,
            end: responseEnd,
            server: Object.fromEntries(
              serverTiming.map(({ name, duration }) => [name, Math.round(duration)]),
            ),
          })),
      }));
      return spans
        .map((span, nth) => ({ ...span, nth }))
        .toSorted((a, b) => b.latency - a.latency)
        .slice(0, count)
        .map(({ start, latency, nth }) => ({
          latency: Math.round(latency),
          nth,
          asks: asks
            .filter((ask) => ask.start >= start && ask.start < start + latency)
            .map(({ name, start: at, end, server }): Ask => ({
              name,
              after: Math.round(at - start),
              took: Math.round(end - at),
              server,
            })),
          scripts: scriptsDuring(frames, start, start + latency),
        }));
    },
  };
}

/** The scripts that ran longest in the long frames overlapping a span, longest first. */
function scriptsDuring(frames: readonly LongFrame[], start: number, end: number) {
  return frames
    .filter((frame) => frame.end > start && frame.start < end)
    .flatMap((frame) => frame.scripts)
    .toSorted((a, b) => b.duration - a.duration)
    .slice(0, 5);
}

export type InputLatency = Awaited<ReturnType<typeof inputLatency>>;
