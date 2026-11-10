import { EmptyState } from '@astryxdesign/core/EmptyState';
import { Icon } from '@astryxdesign/core/Icon';
import { IconButton } from '@astryxdesign/core/IconButton';
import { borderVars, colorVars, spacingVars } from '@astryxdesign/core/theme/tokens.stylex';
import * as stylex from '@stylexjs/stylex';
import { ChevronLeft, MailOpen } from 'lucide-react';
import { media, tm } from '../../../app/theme/tokens.stylex.ts';

/**
 * The reader's sheet, where an open conversation lies. On a phone it fills the screen, with a way
 * back to the list at its top.
 */
export function ReaderPane({ onBack }: { onBack: () => void }) {
  return (
    <section aria-label="Reader" {...stylex.props(styles.sheet)}>
      <header {...stylex.props(styles.phoneHeader)}>
        <IconButton
          label="Back"
          icon={<Icon icon={ChevronLeft} />}
          variant="ghost"
          onClick={onBack}
        />
      </header>
      <div {...stylex.props(styles.empty)}>
        <EmptyState
          icon={<Icon icon={MailOpen} size="lg" color="secondary" />}
          title="No conversation open"
          description="Choose one from the list to read it here."
        />
      </div>
    </section>
  );
}

const styles = stylex.create({
  sheet: {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    backgroundColor: {
      default: colorVars['--color-background-surface'],
      [media.phone]: 'transparent',
    },
    borderRadius: { default: tm.paneRadius, [media.phone]: 0 },
    boxShadow: { default: tm.sheetEdge, [media.phone]: 'none' },
    outline: {
      default: null,
      [media.forcedColors]: {
        default: `${borderVars['--border-width']} solid CanvasText`,
        [media.phone]: 'none',
      },
    },
  },
  phoneHeader: {
    display: { default: 'none', [media.phone]: 'flex' },
    paddingTop: tm.safeTop,
    paddingInline: spacingVars['--spacing-2'],
  },
  empty: {
    flexGrow: 1,
    display: 'grid',
    placeItems: 'center',
    padding: spacingVars['--spacing-6'],
  },
});
