import { colorVars, typeScaleVars, typographyVars } from '@astryxdesign/core/theme/tokens.stylex';
import * as stylex from '@stylexjs/stylex';
import { tm } from '../../../app/theme/tokens.stylex.ts';

/** A borderless input lying in a line of the sheet, as each field and the link's address do. */
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
});
