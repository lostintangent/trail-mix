import { Icon } from '@astryxdesign/core/Icon';
import { SegmentedControl, SegmentedControlItem } from '@astryxdesign/core/SegmentedControl';
import { Monitor, Moon, Sun } from 'lucide-react';
import { parse, type ThemeMode } from './mode.ts';

/** System, Light or Dark, saved for this device. */
export function ThemeChoice({
  mode,
  onChange,
}: {
  mode: ThemeMode;
  onChange: (mode: ThemeMode) => void;
}) {
  return (
    <SegmentedControl
      label="Theme"
      value={mode}
      onChange={(value) => onChange(parse(value))}
      size="sm"
      layout="fill"
    >
      <SegmentedControlItem
        value="system"
        label="System"
        icon={<Icon icon={Monitor} />}
        isLabelHidden
      />
      <SegmentedControlItem value="light" label="Light" icon={<Icon icon={Sun} />} isLabelHidden />
      <SegmentedControlItem value="dark" label="Dark" icon={<Icon icon={Moon} />} isLabelHidden />
    </SegmentedControl>
  );
}
