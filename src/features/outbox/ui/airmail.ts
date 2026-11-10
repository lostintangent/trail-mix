import * as stylex from '@stylexjs/stylex';
import { tm } from '../../../app/theme/tokens.stylex.ts';

/**
 * Airmail, which means one thing: this message is leaving. It runs along the top of the undo
 * toast and of each leaving Outbox row. Forced colors keep it, since it's drawn, not filled.
 */
export const airmail = stylex.create({
  stripe: {
    flexShrink: 0,
    height: tm.airmailHeight,
    backgroundImage: tm.airmail,
    forcedColorAdjust: 'none',
  },
});
