import { useEffect } from 'react';
import { preloadComposer } from '../../composer/ui/index.ts';
import { preloadTriageMenus } from '../../conversations/index.ts';
import { preloadSendActions } from '../../outbox/index.ts';
import { preloadReader } from '../../reader/index.ts';

/** How long after the list first shows something to open the reader starts loading. */
const PRELOAD_AFTER_MS = 1_000;

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
    let timer: ReturnType<typeof setTimeout> | undefined;
    let idleId: number | undefined;
    const settle = () => {
      clearTimeout(timer);
      if (idleId !== undefined) cancelIdleCallback(idleId);
      idleId = undefined;
      timer = setTimeout(() => {
        // Safari has no idle callback.
        if ('requestIdleCallback' in window) idleId = requestIdleCallback(preload);
        else preload();
      }, PRELOAD_COMPOSER_AFTER_MS);
    };
    const stop = () => {
      clearTimeout(timer);
      if (idleId !== undefined) cancelIdleCallback(idleId);
      for (const move of MOVES) window.removeEventListener(move, settle, { capture: true });
    };
    const preload = () => {
      stop();
      // One that fails, as offline, is loaded again when the composer opens.
      void Promise.all([preloadComposer(), preloadSendActions()]).catch(() => {});
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
  useEffect(() => {
    if (!isWanted) return;
    const timer = setTimeout(() => {
      // Safari has no idle callback.
      const load = () => {
        // One that fails, as offline, is loaded again when a conversation opens.
        void Promise.all([preloadReader(), preloadTriageMenus()]).catch(() => {});
      };
      if ('requestIdleCallback' in window) requestIdleCallback(load);
      else load();
    }, PRELOAD_AFTER_MS);
    return () => clearTimeout(timer);
  }, [isWanted]);
}
