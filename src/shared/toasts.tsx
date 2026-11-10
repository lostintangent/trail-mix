import type { ToastDismissFn, ToastOptions, ToastViewportProps } from '@astryxdesign/core/Toast';
import { lazy, Suspense, useEffect, useState } from 'react';

/**
 * Toasts, kept off the first load. Astryx's toasts carry their own layers and gestures, which the
 * first screen never needs, so they load once it has had its turn and the browser is idle, or
 * sooner if a toast is shown before then. `toast` shows one wherever `Toasts` is mounted.
 */

/** How long after `Toasts` mounts they start loading, leaving the first screen the network. */
const LOAD_AFTER_MS = 1_000;

type Show = (options: ToastOptions) => ToastDismissFn;

let wanted = false;
const wanters = new Set<() => void>();
let resolveShow: (show: Show) => void;
const shown = new Promise<Show>((resolve) => (resolveShow = resolve));

const Host = lazy(() => import('./toast-host.tsx'));

/** Shows a toast once toasts have loaded, and says how to dismiss it. */
export async function toast(options: ToastOptions): Promise<ToastDismissFn> {
  want();
  return (await shown)(options);
}

/** Where toasts appear, loaded a moment after the first screen or when a toast is first shown. */
export function Toasts({ layerInset }: Pick<ToastViewportProps, 'layerInset'>) {
  const [isWanted, setWanted] = useState(wanted);
  useEffect(() => {
    if (isWanted) return;
    const now = () => setWanted(true);
    wanters.add(now);
    // Safari has no idle callback.
    const whenIdle = () => ('requestIdleCallback' in window ? requestIdleCallback(want) : want());
    const timer = setTimeout(whenIdle, LOAD_AFTER_MS);
    return () => {
      wanters.delete(now);
      clearTimeout(timer);
    };
  }, [isWanted]);
  return isWanted ? (
    <Suspense>
      <Host layerInset={layerInset} onReady={resolveShow} />
    </Suspense>
  ) : null;
}

function want() {
  wanted = true;
  for (const wanter of wanters) wanter();
}
