import { Button } from '@astryxdesign/core/Button';
import { Icon } from '@astryxdesign/core/Icon';
import { IconButton } from '@astryxdesign/core/IconButton';
import {
  colorVars,
  durationVars,
  focusVars,
  radiusVars,
} from '@astryxdesign/core/theme/tokens.stylex';
import * as stylex from '@stylexjs/stylex';
import type { StyleXStyles } from '@stylexjs/stylex';
import { memo, useRef } from 'react';
import { media, tm } from '../../../app/theme/tokens.stylex.ts';
import { LaterTooltip } from '../../../shared/LaterTooltip.tsx';
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
  /**
   * Draws its icon on a small fill of the accent, as the sidebar's one primary action where there's
   * no room for a word. The fill is a line's height, and the target around it a button's.
   */
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
  if (isAccent) return <AccentButton command={command} tooltip={tooltip} />;
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
});

/**
 * A target the size of every button, transparent, around a small fill of the accent with the
 * command's icon on it. Only the fill shows, so it stands no taller than the line beside it, and
 * keyboard focus rings the fill.
 */
function AccentButton({ command, tooltip }: { command: Command; tooltip: string }) {
  const button = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button
        ref={button}
        type="button"
        aria-label={command.title}
        disabled={command.isEnabled === false}
        onClick={() => void command.run()}
        {...stylex.props(styles.accentTarget, stylex.defaultMarker())}
      >
        <span {...stylex.props(styles.accentFill)}>
          {command.icon && <Icon icon={command.icon} size="xsm" color="inherit" />}
        </span>
      </button>
      <LaterTooltip anchor={button} content={tooltip} />
    </>
  );
}

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
  accentTarget: {
    display: 'grid',
    placeItems: 'center',
    flexShrink: 0,
    width: tm.target,
    height: tm.target,
    padding: 0,
    borderWidth: 0,
    backgroundColor: 'transparent',
    cursor: { default: 'pointer', ':disabled': 'default' },
    outline: 'none',
  },
  accentFill: {
    display: 'grid',
    placeItems: 'center',
    width: tm.accentFill,
    height: tm.accentFill,
    borderRadius: radiusVars['--radius-element'],
    color: { default: colorVars['--color-on-accent'], [media.forcedColors]: 'ButtonFace' },
    backgroundColor: {
      default: colorVars['--color-accent'],
      [stylex.when.ancestor(':disabled')]: colorVars['--color-text-disabled'],
      [media.forcedColors]: 'ButtonText',
    },
    // A pointer resting on the target shades the fill, as it shades any button, over a state change.
    boxShadow: {
      default: null,
      [stylex.when.ancestor(':hover')]: {
        default: null,
        '@media (hover: hover)': `inset 0 0 0 ${tm.accentFill} ${colorVars['--color-overlay-hover']}`,
      },
    },
    transitionProperty: 'box-shadow',
    transitionDuration: { default: durationVars['--duration-fast'], [media.reducedMotion]: '0s' },
    forcedColorAdjust: 'none',
    outline: {
      default: null,
      [stylex.when.ancestor(':focus-visible')]:
        `${focusVars['--focus-outline-width']} ${focusVars['--focus-outline-style']} ${focusVars['--focus-outline-color']}`,
    },
    outlineOffset: focusVars['--focus-outline-offset'],
  },
});
