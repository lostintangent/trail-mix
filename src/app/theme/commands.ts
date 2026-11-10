import type { Command } from '../../features/commands/index.ts';
import { openAccentPicker } from './AccentChoice.tsx';
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

/** Picking an accent, from the system's color picker, and going back to ink blue once picked. */
export function accentCommands(
  accent: string | undefined,
  setAccent: (color: string | undefined) => void,
): Command[] {
  return [
    { id: 'accent.pick', title: 'Choose an accent color', group: 'Theme', run: openAccentPicker },
    {
      id: 'accent.default',
      title: 'Use the default accent',
      group: 'Theme',
      isEnabled: accent !== undefined,
      run: () => setAccent(undefined),
    },
  ];
}
