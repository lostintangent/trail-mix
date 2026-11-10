import { EmptyState } from '@astryxdesign/core/EmptyState';
import { Icon } from '@astryxdesign/core/Icon';
import { borderVars, colorVars, spacingVars } from '@astryxdesign/core/theme/tokens.stylex';
import * as stylex from '@stylexjs/stylex';
import { MailOpen } from 'lucide-react';
import { media, tm } from '../../../app/theme/tokens.stylex.ts';

/** The reader's sheet, where an open conversation lies. */
export function ReaderPane() {
  return (
    <section aria-label="Reader" {...stylex.props(styles.sheet)}>
      <EmptyState
        icon={<Icon icon={MailOpen} size="lg" color="secondary" />}
        title="No conversation open"
        description="Choose one from the list to read it here."
      />
    </section>
  );
}

const styles = stylex.create({
  sheet: {
    display: 'grid',
    placeItems: 'center',
    height: '100%',
    padding: spacingVars['--spacing-6'],
    backgroundColor: colorVars['--color-background-surface'],
    borderRadius: tm.paneRadius,
    boxShadow: tm.sheetEdge,
    outline: {
      default: null,
      [media.forcedColors]: `${borderVars['--border-width']} solid CanvasText`,
    },
  },
});
