import { spacingVars, typeScaleVars } from '@astryxdesign/core/theme/tokens.stylex';
import * as stylex from '@stylexjs/stylex';
import { useId, type ReactNode } from 'react';
import { media, tm } from './tokens.stylex.ts';

/** A page in the reader's place, as Settings and an account's page are: a serif title over it. */
export function ReaderPage({
  title,
  xstyle,
  children,
}: {
  title: ReactNode;
  xstyle?: stylex.StyleXStyles;
  children: ReactNode;
}) {
  const titleId = useId();
  return (
    <section aria-labelledby={titleId} {...stylex.props(styles.page, xstyle)}>
      <h1 id={titleId} {...stylex.props(styles.title)}>
        {title}
      </h1>
      {children}
    </section>
  );
}

const styles = stylex.create({
  page: {
    display: 'flex',
    flexDirection: 'column',
    gap: spacingVars['--spacing-4'],
    width: '100%',
    maxWidth: tm.measure,
    paddingInline: {
      default: spacingVars['--spacing-6'],
      [media.phone]: spacingVars['--spacing-3'],
    },
    paddingBottom: spacingVars['--spacing-6'],
  },
  title: {
    margin: 0,
    fontFamily: tm.serif,
    fontSize: typeScaleVars['--text-heading-1-size'],
    fontWeight: typeScaleVars['--text-heading-1-weight'],
    lineHeight: typeScaleVars['--text-heading-1-leading'],
    overflowWrap: 'anywhere',
  },
});
