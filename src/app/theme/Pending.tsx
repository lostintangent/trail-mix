import { Skeleton } from '@astryxdesign/core/Skeleton';
import { durationVars } from '@astryxdesign/core/theme/tokens.stylex';
import { VisuallyHidden } from '@astryxdesign/core/VisuallyHidden';
import * as stylex from '@stylexjs/stylex';
import { useState, type ReactNode } from 'react';
import { media, tm } from './tokens.stylex.ts';

/**
 * What stands in for something on its way: skeletons in its shape, shown only once it is late, so
 * a fast answer shows nothing. Assistive technology hears `label` instead, as the place is busy.
 *
 * Skeletons that hold a place, as a body's do above the sheets below it, take it at once, so
 * nothing moves when it arrives. Others, as a list's, have nothing below them to hold still, and
 * are drawn only once late, so a fast answer costs nothing either.
 */
export function Pending({
  label,
  children,
  xstyle,
  holdsPlace = true,
}: {
  label: string;
  children: ReactNode;
  xstyle?: stylex.StyleXStyles;
  holdsPlace?: boolean;
}) {
  const [isDrawn, setDrawn] = useState(holdsPlace);
  return (
    <div
      role="status"
      aria-busy
      // Its appearing begins once it is late, under reduced motion too, which is when to draw it.
      onAnimationStart={() => setDrawn(true)}
      {...stylex.props(styles.pending, xstyle)}
    >
      <VisuallyHidden>{label}</VisuallyHidden>
      {isDrawn && children}
    </div>
  );
}

/**
 * A line of text on its way, `width` of its line. It sits on the line it stands in for, so in a
 * box with that text's font and leading it takes the text's height.
 */
export function TextSkeleton({ width, index = 0 }: { width: string; index?: number }) {
  return <Skeleton width={width} height="0.75em" radius={1} index={index} xstyle={styles.text} />;
}

const appear = stylex.keyframes({
  from: { opacity: 0 },
  to: { opacity: 1 },
});

const styles = stylex.create({
  pending: {
    animationName: appear,
    animationDuration: { default: durationVars['--duration-fast'], [media.reducedMotion]: '0s' },
    animationDelay: tm.skeletonDelay,
    animationFillMode: 'both',
    animationTimingFunction: 'ease-out',
  },
  text: {
    display: 'inline-block',
    verticalAlign: 'middle',
  },
});
