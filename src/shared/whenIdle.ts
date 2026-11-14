/** How long after the first screen mounts code it can do without starts loading. */
const AFTER_FIRST_SCREEN_MS = 1_000;

/**
 * Runs `run` once `afterMs` has passed and then the browser is idle. The wait is the first
 * screen's moment unless given, since idle alone comes too soon: a browser waiting on the first
 * screen's queries is idle too, and what loads then competes with the first rows. A run that fails,
 * as a load does offline, is let go, since what needs it loads it again. Returns a way to call it
 * off.
 */
export function whenIdle(run: () => unknown, afterMs = AFTER_FIRST_SCREEN_MS): () => void {
  let idle: number | undefined;
  const settled = () => void Promise.resolve(run()).catch(() => {});
  const timer = setTimeout(() => {
    // Safari has no idle callback.
    if ('requestIdleCallback' in window) idle = requestIdleCallback(settled, { timeout: 5_000 });
    else settled();
  }, afterMs);
  return () => {
    clearTimeout(timer);
    if (idle !== undefined) cancelIdleCallback(idle);
  };
}
