import { colorVars, typeScaleVars, typographyVars } from '@astryxdesign/core/theme/tokens.stylex';
import * as stylex from '@stylexjs/stylex';
import { tm } from '../../../app/theme/tokens.stylex.ts';

/**
 * The composer's inputs: one that lies in a line of the sheet, borderless, as each field and the
 * link's address do, and one hidden from sight that a screen reader or a button still reaches.
 */
export const fieldStyles = stylex.create({
  input: {
    flexGrow: 1,
    minWidth: 0,
    minHeight: tm.target,
    padding: 0,
    borderWidth: 0,
    outline: 'none',
    backgroundColor: 'transparent',
    color: colorVars['--color-text-primary'],
    fontFamily: typographyVars['--font-family-body'],
    fontSize: typeScaleVars['--text-body-size'],
  },
  hidden: {
    position: 'absolute',
    width: '1px',
    height: '1px',
    overflow: 'hidden',
    clipPath: 'inset(50%)',
    whiteSpace: 'nowrap',
  },
});
