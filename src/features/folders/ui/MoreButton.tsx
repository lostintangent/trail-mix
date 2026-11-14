import { Icon } from '@astryxdesign/core/Icon';
import { colorVars, durationVars } from '@astryxdesign/core/theme/tokens.stylex';
import * as stylex from '@stylexjs/stylex';
import { Ellipsis } from 'lucide-react';
import type { ComponentProps } from 'react';
import { media, tm } from '../../../app/theme/tokens.stylex.ts';
import { control } from './controls.ts';

/**
 * The `…` at the end of a sidebar row, always shown, in a quiet tone, so what can be done to the
 * row is in reach without hovering. The row's menu draws itself on this same button once opened.
 * It's out of the Tab order, since the tree is one stop and its row opens the menu by key.
 */
export function MoreButton({ label, ...props }: { label: string } & ComponentProps<'button'>) {
  return (
    <button
      type="button"
      tabIndex={-1}
      aria-label={label}
      aria-haspopup="menu"
      {...props}
      {...stylex.props(control.bare, control.target, styles.more)}
    >
      <Icon icon={Ellipsis} size="sm" />
    </button>
  );
}

const styles = stylex.create({
  // Tinted and brightened while its menu is open, too.
  more: {
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
    transitionProperty: 'background-color, color',
    transitionDuration: {
      default: durationVars['--duration-fast'],
      [media.reducedMotion]: '0s',
    },
  },
});
