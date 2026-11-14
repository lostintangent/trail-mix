import { useEffect } from 'react';
import { preloadComposer } from '../../composer/ui/index.ts';
import { preloadTriageMenus } from '../../conversations/index.ts';
import { preloadSendActions } from '../../outbox/index.ts';
import { preloadReader } from '../../reader/index.ts';
import { whenIdle } from '../../../shared/whenIdle.ts';

/** How long the member rests from keys, pointer and scrolling before the composer loads. */
const PRELOAD_COMPOSER_AFTER_MS = 2_000;

/** What the member does to move through the list, or anything else, which the composer waits out. */
const MOVES = ['keydown', 'pointerdown', 'scroll'] as const;

/**
 * Once the first screen has something to open, the composer loads while the browser is idle, so a
 * reply rarely waits for its code. Its code is large, so it loads only once the member has rested a
 * moment, never while they move through the list.
 */
export function usePreloadedComposer(isWanted: boolean) {
  useEffect(() => {
    if (!isWanted) return;
    let callOff = () => {};
    const settle = () => {
      callOff();
      callOff = whenIdle(preload, PRELOAD_COMPOSER_AFTER_MS);
    };
    const stop = () => {
      callOff();
      for (const move of MOVES) window.removeEventListener(move, settle, { capture: true });
    };
    const preload = () => {
      stop();
      return Promise.all([preloadComposer(), preloadSendActions()]);
    };
    for (const move of MOVES) {
      window.addEventListener(move, settle, { capture: true, passive: true });
    }
    settle();
    return stop;
  }, [isWanted]);
}

/**
 * Once the list shows a conversation to open, the reader and its triage menus load soon after,
 * while the browser is idle, ready for the click.
 */
export function usePreloadedReader(isWanted: boolean) {
  useEffect(
    () =>
      isWanted ? whenIdle(() => Promise.all([preloadReader(), preloadTriageMenus()])) : undefined,
    [isWanted],
  );
}
