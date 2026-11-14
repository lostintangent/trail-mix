import { Icon } from '@astryxdesign/core/Icon';
import { IconButton } from '@astryxdesign/core/IconButton';
import { colorVars, radiusVars, sizeVars } from '@astryxdesign/core/theme/tokens.stylex';
import * as stylex from '@stylexjs/stylex';
import { useRef } from 'react';
import { LaterTooltip } from '../../shared/LaterTooltip.tsx';
import { RotateCcw } from 'lucide-react';
import { preloadAccentMath } from './accent.ts';
import { DEFAULT_ACCENT_HEX } from './palette.ts';
import { focusRing, tm } from './tokens.stylex.ts';

/**
 * The accent this device shows: a swatch of it that opens the system's color picker, and, once the
 * member has picked a color, a way back to ink blue. The swatch shows the accent as the theme
 * shows it, made readable, so it shows what the pick did. A label beside it names the picker by
 * its `id`, and its words describe it.
 */
export function AccentChoice({
  accent,
  onChange,
  id,
  describedBy,
}: {
  accent: string | undefined;
  onChange: (color: string | undefined) => void;
  id: string;
  describedBy: string;
}) {
  const target = useRef<HTMLSpanElement>(null);
  return (
    <>
      <span ref={target} {...stylex.props(styles.target)}>
        <input
          ref={registerPicker}
          id={id}
          type="color"
          aria-label="Accent color"
          aria-describedby={describedBy}
          value={accent ?? DEFAULT_ACCENT_HEX}
          // The math a pick needs loads as the member reaches for the picker, before any pick.
          onPointerDown={preloadAccentMath}
          onFocus={preloadAccentMath}
          onChange={(event) => onChange(event.currentTarget.value)}
          // The marker lets the swatch after it ring itself when the picker has keyboard focus.
          {...stylex.props(styles.input, stylex.defaultMarker())}
        />
        <span {...stylex.props(styles.swatch)} />
      </span>
      <LaterTooltip anchor={target} content="Accent color" />
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
    // Keyboard focus rings the color itself, as a switch's rings its track, so the ring stays clear
    // of whatever the target's reach past it runs into.
    outline: {
      default: null,
      [stylex.when.siblingBefore(':focus-visible')]: focusRing.line,
    },
    outlineOffset: focusRing.outside,
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
