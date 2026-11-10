import type { Command } from '../../features/commands/index.ts';
import type { ThemeMode } from './mode.ts';

/** The theme's choices as commands, leaving out the one already chosen. */
export function themeCommands(mode: ThemeMode, setMode: (mode: ThemeMode) => void): Command[] {
  const titles = {
    light: 'Use the light theme',
    dark: 'Use the dark theme',
    system: 'Match the system theme',
  };
  return (['light', 'dark', 'system'] as const).map((choice) => ({
    id: `theme.${choice}`,
    title: titles[choice],
    group: 'Theme',
    isEnabled: mode !== choice,
    run: () => setMode(choice),
  }));
}
