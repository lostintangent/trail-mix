import type { TooltipProps } from '@astryxdesign/core/Tooltip';
import { useEffect, useSyncExternalStore, type ReactNode, type RefObject } from 'react';
import { afterFirstScreen } from './afterFirstScreen.ts';

/**
 * A control's tooltip, which joins the control once its code arrives, apart from the first screen.
 * A tooltip shows only after a hover or a focus has rested on its control, so a control drawn
 * first and given its tooltip a moment later looks and reads the same: its name is its own, and
 * only the tooltip waits. The code loads once the first screen has settled, or at once when a
 * pointer or focus reaches it, and a tooltip that arrives while one rests there opens straight
 * away.
 */
export function LaterTooltip({
  anchor,
  content,
  placement,
}: {
  /** The control the tooltip belongs to, which keeps its own accessible name. */
  anchor: RefObject<HTMLElement | null>;
  content: ReactNode;
  placement?: TooltipProps['placement'];
}) {
  const Tooltip = useSyncExternalStore(subscribe, loaded);
  useEffect(() => {
    if (loaded()) return;
    const element = anchor.current;
    const want = () => void load();
    element?.addEventListener('pointerenter', want);
    element?.addEventListener('focusin', want);
    const callOff = afterFirstScreen(want);
    return () => {
      element?.removeEventListener('pointerenter', want);
      element?.removeEventListener('focusin', want);
      callOff();
    };
  }, [anchor]);
  if (!Tooltip) return null;
  return (
    <Tooltip
      anchorRef={anchor}
      content={content}
      placement={placement}
      isDefaultOpen={anchor.current?.matches(':hover, :focus-visible') ?? false}
    />
  );
}

type Tooltip = (typeof import('@astryxdesign/core/Tooltip'))['Tooltip'];

let tooltip: Tooltip | undefined;
let loading: Promise<void> | undefined;
const listeners = new Set<() => void>();

const loaded = () => tooltip;

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

function load(): Promise<void> {
  loading ??= import('@astryxdesign/core/Tooltip').then(
    (module) => {
      tooltip = module.Tooltip;
      for (const listener of listeners) listener();
    },
    () => {
      // Without its code a control keeps no tooltip, and the next reach asks again.
      loading = undefined;
    },
  );
  return loading;
}
