import { useEffect } from 'react';
import { useLatest } from '../../../shared/useLatest.ts';
import type { Opening } from './worker.ts';

/**
 * Opens what a tapped notification leads to in this Trail Mix, when the service worker brings it
 * forward rather than opening a new window. `open` gets the address, from Trail Mix's own origin.
 */
export function useNotificationOpenings(open: (address: string) => void) {
  const latest = useLatest(open);
  useEffect(() => {
    const workers = navigator.serviceWorker as ServiceWorkerContainer | undefined;
    if (!workers) return;
    const opened = ({ data, origin }: MessageEvent) => {
      const address = (data as Partial<Opening> | null)?.open;
      if (typeof address !== 'string' || !URL.canParse(address)) return;
      const url = new URL(address);
      if (url.origin !== location.origin || (origin !== '' && origin !== location.origin)) return;
      latest.current(`${url.pathname}${url.search}`);
    };
    workers.addEventListener('message', opened);
    return () => workers.removeEventListener('message', opened);
  }, [latest]);
}
