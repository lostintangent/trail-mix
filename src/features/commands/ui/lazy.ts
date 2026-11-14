import { lazy } from 'react';
import { preloadable } from '../../../shared/preloadable.ts';

/** The palette's list and the shortcut sheet load when first shown, off the first load. */
export const { Component: CommandMatches, preload: preloadCommandMatches } = preloadable(
  async () => (await import('./CommandMatches.tsx')).CommandMatches,
);

export const ShortcutSheet = lazy(async () => ({
  default: (await import('./ShortcutSheet.tsx')).ShortcutSheet,
}));
