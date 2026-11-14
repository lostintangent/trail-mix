import { Icon } from '@astryxdesign/core/Icon';
import { IconButton } from '@astryxdesign/core/IconButton';
import { colorVars } from '@astryxdesign/core/theme/tokens.stylex';
import * as stylex from '@stylexjs/stylex';
import { ListFilter } from 'lucide-react';
import { memo } from 'react';
import { media } from '../../../app/theme/tokens.stylex.ts';
import { useCommands, type Command } from '../../commands/index.ts';
import { UNREAD_ONLY } from './commands.ts';

const ICON = <Icon icon={ListFilter} />;

/**
 * The list header's toggle that lists only the view's unread mail, drawn from its command, and
 * offered only while the command can run: where the view has unread mail, or lists only that.
 */
export function UnreadToggle() {
  const command = useCommands().find(({ id }) => id === UNREAD_ONLY);
  return command && command.isEnabled !== false ? <Toggle command={command} /> : null;
}

// Astryx's ToggleButton, drawn on the IconButton the first load already carries, as its own
// pressed plate. Its name stays the same while it's pressed or not, and its tooltip says what a
// press does.
const Toggle = memo(function Toggle({ command }: { command: Command }) {
  const isPressed = command.isChecked === true;
  return (
    <IconButton
      label="Unread only"
      tooltip={command.title}
      icon={ICON}
      variant="ghost"
      aria-pressed={isPressed}
      xstyle={isPressed ? styles.pressed : undefined}
      onClick={() => void command.run()}
    />
  );
});

const styles = stylex.create({
  pressed: {
    forcedColorAdjust: 'none',
    backgroundColor: {
      default: colorVars['--color-overlay-pressed'],
      [media.forcedColors]: 'Highlight',
    },
    color: { default: null, [media.forcedColors]: 'HighlightText' },
  },
});
