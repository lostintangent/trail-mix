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
  addEventListener('online', onChange);
  addEventListener('offline', onChange);
  return () => {
    removeEventListener('online', onChange);
    removeEventListener('offline', onChange);
  };
}
