import { Icon } from '@astryxdesign/core/Icon';
import { IconButton } from '@astryxdesign/core/IconButton';
import { colorVars, focusVars, radiusVars, sizeVars } from '@astryxdesign/core/theme/tokens.stylex';
import { Tooltip } from '@astryxdesign/core/Tooltip';
import * as stylex from '@stylexjs/stylex';
import { RotateCcw } from 'lucide-react';
import { hexOf, parseColor } from '../../shared/color.ts';
import { DEFAULT_ACCENT } from './palette.ts';
import { tm } from './tokens.stylex.ts';

/** Where the picker starts before the member has picked: ink blue, as paper shows it. */
const DEFAULT_PICK = hexOf(parseColor(DEFAULT_ACCENT.light)!);

/**
 * The accent this device shows: a swatch of it that opens the system's color picker, and, once the
 * member has picked a color, a way back to ink blue. The swatch shows the accent as the theme
 * shows it, made readable, so it shows what the pick did.
 */
export function AccentChoice({
  accent,
  onChange,
}: {
  accent: string | undefined;
  onChange: (color: string | undefined) => void;
}) {
  return (
    <>
      <Tooltip content="Accent color">
        <span {...stylex.props(styles.target)}>
          <span {...stylex.props(styles.swatch)} />
          <input
            ref={registerPicker}
            type="color"
            aria-label="Accent color"
            value={accent ?? DEFAULT_PICK}
            onChange={(event) => onChange(event.currentTarget.value)}
            {...stylex.props(styles.input)}
          />
        </span>
      </Tooltip>
      {accent && (
        <IconButton
          label="Use the default accent"
          tooltip="Use the default accent, ink blue"
          icon={<Icon icon={RotateCcw} />}
          variant="ghost"
          size="sm"
          onClick={() => onChange(undefined)}
        />
      )}
    </>
  );
}

let picker: HTMLInputElement | null = null;

/** The palette's way to the picker, through the swatch wherever it sits. */
export function openAccentPicker(): void {
  if (!picker) return;
  picker.focus();
  try {
    picker.showPicker();
  } catch {
    // A browser that can't show it from here, without the press that ran the command, gets a click.
    picker.click();
  }
}

function registerPicker(input: HTMLInputElement | null) {
  picker = input;
  return () => {
    if (picker === input) picker = null;
  };
}

const styles = stylex.create({
  target: {
    position: 'relative',
    display: 'inline-grid',
    placeItems: 'center',
    flexShrink: 0,
    width: sizeVars['--size-element-sm'],
    height: sizeVars['--size-element-sm'],
    borderRadius: radiusVars['--radius-element'],
    backgroundColor: { default: null, ':hover': colorVars['--color-overlay-hover'] },
    outline: {
      default: null,
      [stylex.when.descendant(':focus-visible')]:
        `${focusVars['--focus-outline-width']} ${focusVars['--focus-outline-style']} ${focusVars['--focus-outline-color']}`,
    },
    outlineOffset: focusVars['--focus-outline-offset'],
  },
  swatch: {
    width: tm.swatch,
    height: tm.swatch,
    borderRadius: radiusVars['--radius-full'],
    backgroundColor: colorVars['--color-accent'],
    // Its edge keeps it apart from the desk, whatever was picked.
    boxShadow: `0 0 0 1px ${colorVars['--color-border-emphasized']}`,
    // Forced colors keep it, since the color is what it shows.
    forcedColorAdjust: 'none',
  },
  // Over the whole target, unseen, so a press anywhere on it opens the picker.
  input: {
    position: 'absolute',
    inset: 0,
    width: '100%',
    height: '100%',
    margin: 0,
    padding: 0,
    border: 'none',
    opacity: 0,
    cursor: 'pointer',
  },
});
