import { lazy } from 'react';

/** The palette's list and the shortcut sheet load when first shown, off the first load. */
const loadMatches = () => import('./CommandMatches.tsx');

export const CommandMatches = lazy(async () => ({ default: (await loadMatches()).CommandMatches }));

/** Loads the palette's list ahead, as the field it lies under takes the focus. */
export const preloadCommandMatches = () => void loadMatches().catch(() => {});

export const ShortcutSheet = lazy(async () => ({
  default: (await import('./ShortcutSheet.tsx')).ShortcutSheet,
}));
