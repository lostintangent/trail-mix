import * as stylex from '@stylexjs/stylex';
import { media, tm } from '../../../app/theme/tokens.stylex.ts';

/**
 * Airmail, which means one thing: this message is leaving. It runs along the top of the undo toast,
 * of each leaving Outbox row and of a reply just sent. While the message is on its way, it runs like
 * a barber's pole: its band, one repeat longer than the stripe, slides that repeat over and over, so
 * the loop has no seam. Nothing moves under reduced motion, and forced colors keep it, since it's
 * drawn, not filled.
 */
export function Airmail({
  isRunning,
  xstyle,
}: {
  isRunning: boolean;
  xstyle?: stylex.StyleXStyles;
}) {
  return (
    <span
      aria-hidden
      data-airmail={isRunning ? 'running' : 'still'}
      {...stylex.props(styles.stripe, xstyle)}
    >
      <span {...stylex.props(styles.band, isRunning && styles.running)} />
    </span>
  );
}

const run = stylex.keyframes({
  from: { transform: `translateX(calc(-1 * ${tm.airmailRepeat}))` },
  to: { transform: 'translateX(0)' },
});

const styles = stylex.create({
  stripe: {
    display: 'block',
    flexShrink: 0,
    height: tm.airmailHeight,
    overflow: 'hidden',
  },
  band: {
    display: 'block',
    width: `calc(100% + ${tm.airmailRepeat})`,
    height: '100%',
    backgroundImage: tm.airmail,
    forcedColorAdjust: 'none',
  },
  running: {
    animationName: { default: run, [media.reducedMotion]: 'none' },
    animationDuration: tm.airmailTurn,
    animationTimingFunction: 'linear',
    animationIterationCount: 'infinite',
  },
});
