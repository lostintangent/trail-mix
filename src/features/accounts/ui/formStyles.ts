import { fontWeightVars, spacingVars, typeScaleVars } from '@astryxdesign/core/theme/tokens.stylex';
import * as stylex from '@stylexjs/stylex';
import { tm } from '../../../app/theme/tokens.stylex.ts';

/** How an account's pages lay out their forms, alike wherever a member adds, edits or signs in. */
export const formStyles = stylex.create({
  // Astryx draws a field and a segmented choice at a fixed height, which a finger needs at 44px.
  control: {
    height: tm.target,
  },
  form: {
    display: 'flex',
    flexDirection: 'column',
    gap: spacingVars['--spacing-4'],
    margin: 0,
  },
  legend: {
    padding: 0,
    marginBottom: spacingVars['--spacing-1'],
    fontWeight: fontWeightVars['--font-weight-semibold'],
  },
  quiet: {
    margin: 0,
    color: tm.textQuiet,
    fontSize: typeScaleVars['--text-supporting-size'],
  },
  actions: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: spacingVars['--spacing-2'],
  },
});
