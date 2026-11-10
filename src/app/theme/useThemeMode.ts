import { useSyncExternalStore } from 'react';
import { readThemeMode, saveThemeMode, subscribeToThemeMode, type ThemeMode } from './mode.ts';

/** This device's color mode, and a way to choose another. */
export function useThemeMode(): [ThemeMode, (mode: ThemeMode) => void] {
  const mode = useSyncExternalStore(subscribeToThemeMode, readThemeMode);
  return [mode, saveThemeMode];
}
