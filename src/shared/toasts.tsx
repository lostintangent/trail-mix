import type { ToastDismissFn, ToastViewportProps } from '@astryxdesign/core/Toast';
import type { LucideIcon } from 'lucide-react';
import { lazy, memo, Suspense, useEffect, useState, type ReactNode } from 'react';
import { afterFirstScreen } from './afterFirstScreen.ts';

/**
 * Toasts, kept off the first load. Astryx's toasts carry their own layers and gestures, which the
 * first screen never needs, so they load once it has had its turn and the browser is idle, or
 * sooner if a toast is shown before then. `toast` shows one wherever `Toasts` is mounted.
 */

/** A toast: what it says, whether it reports an error, and the one thing it offers to do. */
export type Toast = {
  /** What the toast says, and what assistive tech announces as it appears. */
  body: ReactNode;
  type?: 'info' | 'error';
  /**
   * A button at the toast's end, set off from its close by a short rule, which also dismisses the
   * toast. With an icon, as Undo has, it shows the icon alone, named by its label, and its tooltip
   * says what it does and the keys that do it too.
   */
  action?: { label: string; icon?: LucideIcon; tooltip?: string; onAction: () => void };
  /**
   * Draws the whole card in place of `body` and `action`, for a toast that changes as it shows.
   * `body` is still what's announced. Such a toast stays until it calls `dismiss`.
   */
  render?: (dismiss: () => void) => ReactNode;
  /** Called once the toast has gone, however it went: dismissed, or swiped away. */
  onHide?: () => void;
};

export type ShowToast = (toast: Toast) => ToastDismissFn;

let wanted = false;
const wanters = new Set<() => void>();
let resolveShow: (show: ShowToast) => void;
const shown = new Promise<ShowToast>((resolve) => (resolveShow = resolve));

const Host = lazy(() => import('./toast-host.tsx'));

/** Shows a toast once toasts have loaded, and says how to dismiss it. */
export async function toast(toast: Toast): Promise<ToastDismissFn> {
  want();
  return (await shown)(toast);
}

/** Where toasts appear, loaded a moment after the first screen or when a toast is first shown. */
export const Toasts = memo(function Toasts({ layerInset }: Pick<ToastViewportProps, 'layerInset'>) {
  const [isWanted, setWanted] = useState(wanted);
  useEffect(() => {
    if (isWanted) return;
    const now = () => setWanted(true);
    wanters.add(now);
    const callOff = afterFirstScreen(want);
    return () => {
      wanters.delete(now);
      callOff();
    };
  }, [isWanted]);
  return isWanted ? (
    <Suspense>
      <Host layerInset={layerInset} onReady={resolveShow} />
    </Suspense>
  ) : null;
});

function want() {
  wanted = true;
  for (const wanter of wanters) wanter();
}
