import { Icon } from '@astryxdesign/core/Icon';
import { IconButton } from '@astryxdesign/core/IconButton';
import { durationVars } from '@astryxdesign/core/theme/tokens.stylex';
import * as stylex from '@stylexjs/stylex';
import { PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { memo } from 'react';
import { media } from '../../../app/theme/tokens.stylex.ts';
import {
  isApple,
  primaryShortcut,
  shortcutLabel,
  useCommands,
  type Command,
} from '../../commands/index.ts';
import { FOLD_SIDEBAR } from './commands.ts';

/**
 * The button that folds the sidebar to its rail and back, drawn from its command, which the
 * sidebar pins over both its layouts. Its two icons crossfade in place, so it never moves.
 */
export function FoldToggle() {
  const command = useCommands().find(({ id }) => id === FOLD_SIDEBAR);
  return command ? <Toggle command={command} /> : null;
}

// It renders again only when the command changes how it looks.
const Toggle = memo(function Toggle({ command }: { command: Command }) {
  const isUnfolded = command.isChecked === true;
  return (
    <IconButton
      label={command.title}
      tooltip={
        command.shortcut
          ? `${command.title} (${shortcutLabel(primaryShortcut(command.shortcut), isApple)})`
          : command.title
      }
      icon={
        <span {...stylex.props(styles.icons)}>
          <Icon icon={PanelLeftClose} xstyle={[styles.icon, !isUnfolded && styles.gone]} />
          <Icon icon={PanelLeftOpen} xstyle={[styles.icon, isUnfolded && styles.gone]} />
        </span>
      }
      variant="ghost"
      onClick={() => void command.run()}
    />
  );
});

const styles = stylex.create({
  icons: {
    display: 'grid',
  },
  icon: {
    gridArea: '1 / 1',
    transitionProperty: 'opacity',
    transitionDuration: { default: durationVars['--duration-fast'], [media.reducedMotion]: '0s' },
  },
  gone: {
    opacity: 0,
  },
});
