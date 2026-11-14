import { useEffect, useLayoutEffect, useSyncExternalStore } from 'react';
import { afterFirstScreen } from '../../shared/afterFirstScreen.ts';
import { readAccent, saveAccent, showAccent, subscribeToAccent } from './accent.ts';

/**
 * This device's accent, kept on the page, and a way to pick another or, with undefined, go back
 * to the default. The app calls it once, at its root.
 */
export function useAccent(): [string | undefined, (color: string | undefined) => void] {
  const accent = useSyncExternalStore(subscribeToAccent, readAccent);
  useLayoutEffect(() => showAccent(accent), [accent]);
  // The copy prepaint replays is remade from the pick, in case the math behind it has changed, once
  // the first screen has settled.
  useEffect(() => afterFirstScreen(() => saveAccent(readAccent())), []);
  return [accent, pick];
}

const pick = (color: string | undefined) => void saveAccent(color);
