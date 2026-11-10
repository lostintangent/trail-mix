import { Button } from '@astryxdesign/core/Button';
import { Icon } from '@astryxdesign/core/Icon';
import { IconButton } from '@astryxdesign/core/IconButton';
import { spacingVars, typeScaleVars, typographyVars } from '@astryxdesign/core/theme/tokens.stylex';
import * as stylex from '@stylexjs/stylex';
import type { StyleXStyles } from '@stylexjs/stylex';
import { label } from '../core/keys.ts';
import { isApple, useCommands, type Command } from '../registry.ts';

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

/**
 * The registry's command of one id as an icon button. It finds the command as it renders, so the
 * same element serves every render, and a pane memoized around it renders only when it must.
 */
export function RegisteredCommandButton({ id }: { id: string }) {
  const command = useCommands().find((each) => each.id === id);
  return command ? <CommandButton command={command} /> : null;
}

/**
 * A pane's primary command as a full-width button, with its icon, its title and, at the end, the
 * key that runs it. It finds the command in the registry by id as it renders, so the same element
 * serves every render, and a pane memoized around it renders only when it must.
 */
export function PrimaryCommandButton({ id }: { id: string }) {
  const command = useCommands().find((each) => each.id === id);
  if (!command) return null;
  return (
    <Button
      label={command.title}
      variant="primary"
      width="100%"
      isDisabled={command.isEnabled === false}
      onClick={() => void command.run()}
      endContent={
        command.shortcut && (
          <span aria-hidden {...stylex.props(styles.key)}>
            {label(command.shortcut, isApple)}
          </span>
        )
      }
      xstyle={styles.button}
    >
      <span {...stylex.props(styles.title)}>
        {command.icon && <Icon icon={command.icon} size="sm" />}
        {command.title}
      </span>
    </Button>
  );
}

const styles = stylex.create({
  // The icon and title start the line, and the key ends it.
  button: {
    justifyContent: 'space-between',
  },
  title: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: spacingVars['--spacing-2'],
  },
  key: {
    fontFamily: typographyVars['--font-family-code'],
    fontSize: typeScaleVars['--text-supporting-size'],
  },
});
