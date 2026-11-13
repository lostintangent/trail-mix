import {
  borderVars,
  colorVars,
  focusVars,
  fontWeightVars,
  radiusVars,
  spacingVars,
} from '@astryxdesign/core/theme/tokens.stylex';
import * as stylex from '@stylexjs/stylex';
import { media } from '../../../app/theme/tokens.stylex.ts';

/**
 * What the line under a conversation's or a bundle's heading holds once it has come, beyond what
 * its skeleton draws. Only the readers that load after the first screen draw it, so it loads with
 * them.
 */
export const metaStyles = stylex.create({
  // The account's stamp, leading the line.
  stamp: {
    width: spacingVars['--spacing-2'],
    height: spacingVars['--spacing-2'],
    flexShrink: 0,
    borderRadius: radiusVars['--radius-inner'],
    outline: {
      default: null,
      [media.forcedColors]: `${borderVars['--border-width']} solid CanvasText`,
    },
  },
  // A line that holds a link wraps between its parts.
  wrapping: {
    flexWrap: 'wrap',
    columnGap: spacingVars['--spacing-1-5'],
    rowGap: 0,
  },
  // Where the conversation lives on another site, as a bundle's repository or a thread on GitHub.
  link: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: spacingVars['--spacing-1'],
    color: colorVars['--color-text-accent'],
    fontWeight: fontWeightVars['--font-weight-medium'],
    textDecoration: { default: 'none', ':hover': 'underline' },
    borderRadius: radiusVars['--radius-inner'],
    outline: {
      default: null,
      ':focus-visible': `${focusVars['--focus-outline-width']} ${focusVars['--focus-outline-style']} ${focusVars['--focus-outline-color']}`,
    },
  },
  linkIcon: {
    color: 'inherit',
  },
});
