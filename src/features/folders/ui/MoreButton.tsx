import { Icon } from '@astryxdesign/core/Icon';
import {
  colorVars,
  durationVars,
  focusVars,
  radiusVars,
} from '@astryxdesign/core/theme/tokens.stylex';
import * as stylex from '@stylexjs/stylex';
import { Ellipsis } from 'lucide-react';
import type { ComponentProps } from 'react';
import { media, tm } from '../../../app/theme/tokens.stylex.ts';

/**
 * The `…` at the end of a sidebar row, always shown, in a quiet tone, so what can be done to the
 * row is in reach without hovering. The row's menu draws itself on this same button once opened.
 */
export function MoreButton({ label, ...props }: { label: string } & ComponentProps<'button'>) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-haspopup="menu"
      {...props}
      {...stylex.props(styles.more)}
    >
      <Icon icon={Ellipsis} size="sm" />
    </button>
  );
}

// The focus ring every Astryx control draws, for the sidebar's own buttons.
const FOCUS_RING = `${focusVars['--focus-outline-width']} ${focusVars['--focus-outline-style']} ${focusVars['--focus-outline-color']}`;

const styles = stylex.create({
  more: {
    display: 'grid',
    placeItems: 'center',
    flexShrink: 0,
    width: tm.target,
    height: tm.target,
    padding: 0,
    borderWidth: 0,
    borderRadius: radiusVars['--radius-element'],
    backgroundColor: {
      default: 'transparent',
      ':hover': { default: null, '@media (hover: hover)': colorVars['--color-overlay-hover'] },
      ':is([aria-expanded="true"])': colorVars['--color-overlay-hover'],
    },
    color: {
      default: tm.textQuiet,
      ':hover': { default: null, '@media (hover: hover)': colorVars['--color-text-primary'] },
      ':is([aria-expanded="true"])': colorVars['--color-text-primary'],
    },
    cursor: 'pointer',
    outline: { default: null, ':focus-visible': FOCUS_RING },
    outlineOffset: '-2px',
    transitionProperty: 'background-color, color',
    transitionDuration: {
      default: durationVars['--duration-fast'],
      [media.reducedMotion]: '0s',
    },
  },
});
