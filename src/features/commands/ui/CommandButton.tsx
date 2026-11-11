import { Button } from '@astryxdesign/core/Button';
import { Icon } from '@astryxdesign/core/Icon';
import { IconButton } from '@astryxdesign/core/IconButton';
import * as stylex from '@stylexjs/stylex';
import type { StyleXStyles } from '@stylexjs/stylex';
import { memo } from 'react';
import { label } from '../core/keys.ts';
import { isApple, useCommands, type Command } from '../registry.ts';

/**
 * A command as an icon button: its title is the button's name, and its tooltip adds the key that
 * runs it, so the visible control teaches the shortcut.
 *
 * A pane's main action, such as Write or Reply at the far end of a phone's island, is an ink-blue
 * primary button with its icon and a word instead.
 *
 * It renders again only when its props change, so a command that keeps its identity while it looks
 * the same, as `useSteadyCommands` keeps it, costs nothing as what's around it renders.
 */
export const CommandButton = memo(function CommandButton({
  command,
  iconStyle,
  primary,
  isAccent = false,
}: {
  command: Command;
  /** How the icon looks, such as marked with the highlighter while a toggle is on. */
  iconStyle?: StyleXStyles;
  /** Draws it as the pane's main action, with this word, such as "Write" for New message. */
  primary?: string;
  /** Draws its icon on the accent, as a pane's main action where there's no room for a word. */
  isAccent?: boolean;
}) {
  if (primary !== undefined) {
    return (
      <Button
        label={primary}
        variant="primary"
        icon={command.icon && <Icon icon={command.icon} />}
        isDisabled={command.isEnabled === false}
        onClick={() => void command.run()}
        xstyle={styles.farEnd}
      />
    );
  }
  const tooltip = command.shortcut
    ? `${command.title} (${label(command.shortcut, isApple)})`
    : command.title;
  return (
    <IconButton
      label={command.title}
      tooltip={tooltip}
      icon={command.icon && <Icon icon={command.icon} xstyle={iconStyle} />}
      variant={isAccent ? 'primary' : 'ghost'}
      isDisabled={command.isEnabled === false}
      onClick={() => void command.run()}
    />
  );
});

/**
 * The registry's command of one id as an icon button. It finds the command as it renders, so the
 * same element serves every render, and a pane memoized around it renders only when it must.
 */
export function RegisteredCommandButton({ id, isAccent }: { id: string; isAccent?: boolean }) {
  const command = useCommands().find((each) => each.id === id);
  return command ? <CommandButton command={command} isAccent={isAccent} /> : null;
}

const styles = stylex.create({
  farEnd: {
    marginInlineStart: 'auto',
  },
});
