import * as stylex from '@stylexjs/stylex';
import type { StampColor } from '../../features/mail/core/index.ts';
import { stampStyles } from './stamps.ts';

/** An account's stamp as a small square beside its name. Forced colors keep it, since it's the only cue. */
export function StampDot({ stamp }: { stamp: StampColor }) {
  return <span {...stylex.props(styles.dot, stampStyles[stamp])} />;
}

const styles = stylex.create({
  dot: {
    flexShrink: 0,
    width: '8px',
    height: '8px',
    borderRadius: '3px',
    forcedColorAdjust: 'none',
  },
});
