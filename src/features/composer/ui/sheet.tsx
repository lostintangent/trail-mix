import {
  borderVars,
  colorVars,
  shadowVars,
  spacingVars,
  typeScaleVars,
} from '@astryxdesign/core/theme/tokens.stylex';
import * as stylex from '@stylexjs/stylex';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Pending, TextSkeleton } from '../../../app/theme/Pending.tsx';
import { media, tm } from '../../../app/theme/tokens.stylex.ts';
import type { Compose } from './Composer.tsx';

/**
 * The sheet the member writes on, which the composer and its skeleton share, so the skeleton lies
 * where the composer will. It loads with the first screen, and the composer's editor apart from it.
 */

/**
 * The composer on its way, while its code loads or a draft's words do: its sheet where it will lie,
 * with lines in the shape of its fields and what's written, shown only once it is late.
 */
export function ComposerSkeleton({
  isNew,
  isSheet,
  onClose,
}: {
  /** Whether it stands alone, filling the reader with a Subject, rather than under its parent. */
  isNew: boolean;
  /** Whether it rises over everything, as on a phone. */
  isSheet: boolean;
  onClose: () => void;
}) {
  const sheet = (
    <section
      aria-label="Message"
      aria-busy
      {...stylex.props(sheetStyles.sheet, isNew && sheetStyles.full, isSheet && sheetStyles.risen)}
    >
      <Pending label="Opening the message" xstyle={[styles.lines, isSheet && styles.inset]}>
        <span {...stylex.props(styles.line)}>
          <TextSkeleton width="40%" />
        </span>
        {isNew && (
          <span {...stylex.props(styles.line)}>
            <TextSkeleton width="55%" index={1} />
          </span>
        )}
        {WRITTEN.map((width, line) => (
          <span key={line} {...stylex.props(styles.line, line === 0 && styles.gap)}>
            <TextSkeleton width={width} index={line + 2} />
          </span>
        ))}
      </Pending>
    </section>
  );
  return isSheet ? <Over onClose={onClose}>{sheet}</Over> : sheet;
}

/** Lines of what's written, of the lengths a few sentences have. */
const WRITTEN = ['92%', '84%', '60%'];

/** A sheet that rises over everything, as on a phone, over a scrim that closes it. */
export function Over({ children, onClose }: { children: ReactNode; onClose: () => void }) {
  return createPortal(
    <>
      <div aria-hidden onClick={onClose} {...stylex.props(sheetStyles.scrim)} />
      {children}
    </>,
    document.body,
  );
}

/** Whether a composer lies under the conversation it answers, rather than filling the reader. */
export function isDocked(compose: Compose): boolean {
  switch (compose.as) {
    case 'new':
      return false;
    case 'reply':
      return true;
    case 'draft':
      return compose.conversation.some(({ flags }) => !flags.draft);
    case 'resumed':
      return compose.isDocked;
  }
}

const FOCUS_WIDTH = `calc(${borderVars['--border-width']} * 2)`;

/** A phone's sheet rises from the bottom of the screen. */
const rise = stylex.keyframes({
  from: { transform: 'translateY(100%)' },
  to: { transform: 'translateY(0)' },
});

export const sheetStyles = stylex.create({
  sheet: {
    display: 'flex',
    flexDirection: 'column',
    gap: spacingVars['--spacing-2'],
    padding: spacingVars['--spacing-4'],
    borderRadius: tm.sheetRadius,
    backgroundColor: colorVars['--color-background-surface'],
    // While the member writes, the sheet wears the ink-blue ring that marks where typing goes.
    boxShadow: {
      default: tm.sheetEdge,
      ':focus-within': `0 0 0 ${FOCUS_WIDTH} ${colorVars['--color-accent']}`,
    },
    outline: {
      default: null,
      [media.forcedColors]: {
        default: `${borderVars['--border-width']} solid CanvasText`,
        ':focus-within': `${FOCUS_WIDTH} solid Highlight`,
      },
    },
  },
  full: {
    flexGrow: 1,
  },
  // On a phone: over everything, from just below the top of the screen to its bottom edge, with
  // its header and toolbar fixed and what's written scrolling between them.
  risen: {
    position: 'fixed',
    insetInline: 0,
    bottom: 0,
    top: `calc(${tm.safeTop} + ${spacingVars['--spacing-6']})`,
    zIndex: 2,
    gap: 0,
    padding: 0,
    paddingBottom: tm.safeBottom,
    borderEndStartRadius: 0,
    borderEndEndRadius: 0,
    boxShadow: shadowVars['--shadow-high'],
    animationName: { default: rise, [media.reducedMotion]: 'none' },
    animationDuration: '300ms',
    animationTimingFunction: tm.easeLayout,
  },
  scrim: {
    position: 'fixed',
    inset: 0,
    zIndex: 2,
    backgroundColor: colorVars['--color-overlay'],
  },
});

const styles = stylex.create({
  lines: {
    display: 'flex',
    flexDirection: 'column',
    fontSize: typeScaleVars['--text-body-size'],
    lineHeight: typeScaleVars['--text-body-leading'],
  },
  // A rising sheet holds its fields inset, as its header and editor are.
  inset: {
    padding: spacingVars['--spacing-4'],
  },
  line: {
    height: '1lh',
  },
  gap: {
    marginBlockStart: spacingVars['--spacing-3'],
  },
});
