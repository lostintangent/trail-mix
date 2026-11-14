/** How long after the first screen mounts code it can do without starts loading. */
const AFTER_FIRST_SCREEN_MS = 1_000;

/**
 * Runs `load` once the first screen has had its moment and then the browser is idle. Idle alone
 * comes too soon: a browser waiting on the first screen's queries is idle too, and what loads then
 * competes with the first rows. A load that fails, as one does offline, is let go, since what needs
 * it loads it again. Returns a way to call it off.
 */
export function afterFirstScreen(load: () => unknown): () => void {
  let idle: number | undefined;
  const run = () => void Promise.resolve(load()).catch(() => {});
  const timer = setTimeout(() => {
    // Safari has no idle callback.
    if ('requestIdleCallback' in window) idle = requestIdleCallback(run, { timeout: 5_000 });
    else run();
  }, AFTER_FIRST_SCREEN_MS);
  return () => {
    clearTimeout(timer);
    if (idle !== undefined) cancelIdleCallback(idle);
  };
}
