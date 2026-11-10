import { Icon } from '@astryxdesign/core/Icon';
import { IconButton } from '@astryxdesign/core/IconButton';
import { Monitor, Moon, Sun } from 'lucide-react';
import type { ThemeMode } from './mode.ts';

const MODES = {
  system: { label: 'System', icon: Monitor, next: 'light' },
  light: { label: 'Light', icon: Sun, next: 'dark' },
  dark: { label: 'Dark', icon: Moon, next: 'system' },
} as const satisfies Record<ThemeMode, { label: string; icon: typeof Sun; next: ThemeMode }>;

/** The theme this device shows, System, Light or Dark. Each press moves to the next. */
export function ThemeChoice({
  mode,
  onChange,
}: {
  mode: ThemeMode;
  onChange: (mode: ThemeMode) => void;
}) {
  const { label, icon, next } = MODES[mode];
  return (
    <IconButton
      label={`Theme: ${label}`}
      tooltip={`Theme: ${label}. Switch to ${MODES[next].label}`}
      icon={<Icon icon={icon} />}
      variant="ghost"
      size="sm"
      onClick={() => onChange(next)}
    />
  );
}
