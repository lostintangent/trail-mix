/** How often a page left open asks whether a newer worker has been deployed. */
const UPDATE_EVERY_MS = 60 * 60_000;

/** Whether Trail Mix runs as an installed app, not in a browser's tab. */
export function isInstalled(): boolean {
  const standalone = (navigator as Navigator & { standalone?: boolean }).standalone;
  return standalone === true || matchMedia('(display-mode: standalone)').matches;
}

/**
 * Has the installed app keep what it needs to open offline, once the page has loaded so the worker
 * never competes with it. A page left open, as a phone's often is, asks for a newer worker when it
 * comes back into view, at most hourly.
 */
export function keepForOffline(): void {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator) || !isInstalled()) return;
  const register = async () => {
    const registration = await navigator.serviceWorker.register('/sw.js', {
      scope: '/',
      updateViaCache: 'none',
    });
    let checkedAt = Date.now();
    addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible' || Date.now() - checkedAt < UPDATE_EVERY_MS)
        return;
      checkedAt = Date.now();
      registration.update().catch(() => {});
    });
  };
  const start = () => setTimeout(() => void register().catch(() => {}), 0);
  if (document.readyState === 'complete') start();
  else addEventListener('load', start, { once: true });
}
