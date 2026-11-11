/** How long after the first screen mounts code it can do without starts loading. */
export const AFTER_FIRST_SCREEN_MS = 1_000;

/**
 * Runs `load` once the first screen has had its moment and then the browser is idle. Idle alone
 * comes too soon: a browser waiting on the first screen's queries is idle too, and what loads then
 * competes with the first rows. Returns a way to call it off.
 */
export function afterFirstScreen(load: () => void): () => void {
  let idle: number | undefined;
  const timer = setTimeout(() => {
    // Safari has no idle callback.
    if ('requestIdleCallback' in window) idle = requestIdleCallback(load, { timeout: 5_000 });
    else load();
  }, AFTER_FIRST_SCREEN_MS);
  return () => {
    clearTimeout(timer);
    if (idle !== undefined) cancelIdleCallback(idle);
  };
}
