import { useEffect, useEffectEvent } from 'react';

/** How often a countdown looks at the clock, so each second turns over on time. */
const TICK_MS = 250;

/** Wakes just after `at` on this device's clock, if there is one, with the time it woke at. */
export function useWakeAt(at: number | undefined, wake: (now: number) => void) {
  const woke = useEffectEvent(wake);
  useEffect(() => {
    if (at === undefined) return;
    const timer = setTimeout(() => woke(Date.now()), Math.max(0, at - Date.now()) + 1);
    return () => clearTimeout(timer);
  }, [at]);
}

/** Ticks with the time while a countdown runs, often enough that each second turns over on time. */
export function useTicking(isTicking: boolean, tick: (now: number) => void) {
  const ticked = useEffectEvent(tick);
  useEffect(() => {
    if (!isTicking) return;
    const timer = setInterval(() => ticked(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, [isTicking]);
}
