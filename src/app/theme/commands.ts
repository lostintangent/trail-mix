import type { Command } from '../../features/commands/index.ts';

/**
 * Picking an accent, from the system's color picker beside the swatch in Settings, which opens there
 * to show it, and going back to ink blue once picked.
 */
export function accentCommands(
  accent: string | undefined,
  setAccent: (color: string | undefined) => void,
  openSettingsAtAccent: () => void,
): Command[] {
  return [
    {
      id: 'accent.pick',
      title: 'Choose an accent color',
      group: 'Theme',
      run: openSettingsAtAccent,
    },
    {
      id: 'accent.default',
      title: 'Use the default accent',
      group: 'Theme',
      isEnabled: accent !== undefined,
      run: () => setAccent(undefined),
    },
  ];
}
