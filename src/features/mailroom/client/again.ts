import type { Unanswered } from './rpc.ts';

/**
 * Makes a call until the Mailroom answers it, for a call it answers alike however often it's asked.
 * A call that got no answer may never have reached the Mailroom, or may have lost its answer on the
 * way back, so it asks again after 1, 2 and 4 seconds, then less often, up to every half minute,
 * and at once when the network comes back or the page is seen again. From the fourth failure on,
 * `onUnreached` hears each. A refusal is the Mailroom's answer, and ends it, as `signal` does.
 */
export async function untilAnswered<T>(
  call: () => Promise<T>,
  { signal, onUnreached }: { signal?: AbortSignal; onUnreached?: (error: unknown) => void } = {},
): Promise<T> {
  for (let failures = 0; ; failures++) {
    try {
      return await call();
    } catch (error) {
      if ((error as Unanswered).isRefused || signal?.aborted) throw error;
      if (failures >= QUICK_ASKS) onUnreached?.(error);
      await chance(Math.min(LONGEST_WAIT_MS, 1_000 * 2 ** failures), signal);
      if (signal?.aborted) throw error;
    }
  }
}

/** How many times a call is asked again quickly, before it's taken as unreached. */
const QUICK_ASKS = 3;
const LONGEST_WAIT_MS = 30_000;

/** Waits `ms`, or until the network comes back, the page is seen again or `signal` aborts. */
function chance(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    const seen = () => {
      if (document.visibilityState === 'visible') done();
    };
    const done = () => {
      clearTimeout(timer);
      removeEventListener('online', done);
      document.removeEventListener('visibilitychange', seen);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    addEventListener('online', done);
    document.addEventListener('visibilitychange', seen);
    signal?.addEventListener('abort', done);
  });
}
