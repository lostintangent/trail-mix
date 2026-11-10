import { Icon } from '@astryxdesign/core/Icon';
import { IconButton } from '@astryxdesign/core/IconButton';
import type { StyleXStyles } from '@stylexjs/stylex';
import { label } from '../core/keys.ts';
import { isApple, type Command } from '../registry.ts';

/**
 * A command as an icon button: its title is the button's name, and its tooltip adds the key that
 * runs it, so the visible control teaches the shortcut.
 */
export function CommandButton({
  command,
  iconStyle,
}: {
  command: Command;
  /** How the icon looks, such as marked with the highlighter while a toggle is on. */
  iconStyle?: StyleXStyles;
}) {
  const tooltip = command.shortcut
    ? `${command.title} (${label(command.shortcut, isApple)})`
    : command.title;
  return (
    <IconButton
      label={command.title}
      tooltip={tooltip}
      icon={command.icon && <Icon icon={command.icon} xstyle={iconStyle} />}
      variant="ghost"
      isDisabled={command.isEnabled === false}
      onClick={() => void command.run()}
    />
  );
}
