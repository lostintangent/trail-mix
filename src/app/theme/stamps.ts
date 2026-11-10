import * as stylex from '@stylexjs/stylex';
import type { StampColor } from '../../features/mail/core/index.ts';
import { tm } from './tokens.stylex.ts';

/** Each account's stamp as a fill: a list row's bar, an account's square, the From chip's dot. */
export const stampStyles: Record<StampColor, stylex.StyleXStyles> = stylex.create({
  vermilion: { backgroundColor: tm.stampVermilion },
  teal: { backgroundColor: tm.stampTeal },
  violet: { backgroundColor: tm.stampViolet },
  amber: { backgroundColor: tm.stampAmber },
  green: { backgroundColor: tm.stampGreen },
  slate: { backgroundColor: tm.stampSlate },
});
