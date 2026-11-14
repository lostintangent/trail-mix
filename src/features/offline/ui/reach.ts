import { useSyncExternalStore } from 'react';
import { isInstalled } from './serviceWorker.ts';

/** Whether the device reaches the Mailroom, and if not, whether it shows what it kept. */
export type Reach = 'online' | 'offline' | 'offline-kept';

/** Follows the browser's network, as it reports going on and off line. */
export function useReach(): Reach {
  const isOnline = useSyncExternalStore(subscribe, () => navigator.onLine);
  if (isOnline) return 'online';
  return isInstalled() ? 'offline-kept' : 'offline';
}

function subscribe(onChange: () => void) {
  const listening = new AbortController();
  addEventListener('online', onChange, { signal: listening.signal });
  addEventListener('offline', onChange, { signal: listening.signal });
  return () => listening.abort();
}
