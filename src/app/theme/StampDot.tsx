import * as stylex from '@stylexjs/stylex';
import type { StampColor } from '../../features/mail/core/index.ts';
import { stampStyles } from './stamps.ts';

/**
 * An account's stamp as a small square beside its name, or a larger one standing for the account
 * on its own, as on the sidebar's rail. Forced colors keep it, since it's the only cue.
 */
export function StampDot({ stamp, isLarge = false }: { stamp: StampColor; isLarge?: boolean }) {
  return <span {...stylex.props(styles.dot, isLarge && styles.large, stampStyles[stamp])} />;
}

const styles = stylex.create({
  dot: {
    flexShrink: 0,
    width: '8px',
    height: '8px',
    borderRadius: '3px',
    forcedColorAdjust: 'none',
  },
  large: {
    width: '12px',
    height: '12px',
    borderRadius: '4px',
  },
});
