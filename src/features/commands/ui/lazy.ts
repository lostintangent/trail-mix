import { lazy } from 'react';

/** The palette's list and the shortcut sheet load when first shown, off the first load. */
export const CommandMatches = lazy(async () => ({
  default: (await import('./CommandMatches.tsx')).CommandMatches,
}));

export const ShortcutSheet = lazy(async () => ({
  default: (await import('./ShortcutSheet.tsx')).ShortcutSheet,
}));
