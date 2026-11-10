import { EmptyState } from '@astryxdesign/core/EmptyState';
import { Heading } from '@astryxdesign/core/Heading';
import { Icon } from '@astryxdesign/core/Icon';
import { IconButton } from '@astryxdesign/core/IconButton';
import { borderVars, colorVars, spacingVars } from '@astryxdesign/core/theme/tokens.stylex';
import * as stylex from '@stylexjs/stylex';
import { ChevronRight, Inbox, Menu } from 'lucide-react';
import { useId } from 'react';
import { media, tm } from '../../../app/theme/tokens.stylex.ts';

/**
 * The conversation list's sheet. On a desktop the whole pane is the sheet, and collapsed to its rail
 * it keeps only a way to open it again. On a phone its header sits on the desk, with a way back to
 * the folders, and the sheet starts below it.
 */
export function ListPane({
  id,
  title,
  isCollapsed,
  onExpand,
  onShowFolders,
}: {
  id: string;
  title: string;
  isCollapsed: boolean;
  onExpand: () => void;
  onShowFolders: () => void;
}) {
  const titleId = useId();
  if (isCollapsed) {
    return (
      <section id={id} aria-label={title} {...stylex.props(styles.pane, styles.rail)}>
        <IconButton
          label={`Show ${title}`}
          tooltip={`Show ${title}`}
          icon={<Icon icon={ChevronRight} />}
          variant="ghost"
          onClick={onExpand}
        />
      </section>
    );
  }
  return (
    <section id={id} aria-labelledby={titleId} {...stylex.props(styles.pane)}>
      <header {...stylex.props(styles.header)}>
        <div {...stylex.props(styles.phoneOnly)}>
          <IconButton
            label="Folders"
            icon={<Icon icon={Menu} />}
            variant="ghost"
            onClick={onShowFolders}
          />
        </div>
        <Heading level={2} id={titleId}>
          {title}
        </Heading>
      </header>
      <div {...stylex.props(styles.sheet)}>
        <EmptyState
          icon={<Icon icon={Inbox} size="lg" color="secondary" />}
          title="No mail yet"
          description="Mail from the accounts you connect will gather here, newest first."
        />
      </div>
    </section>
  );
}

const styles = stylex.create({
  pane: {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    overflow: 'hidden',
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
  rail: {
    alignItems: 'center',
    paddingBlock: spacingVars['--spacing-2'],
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: spacingVars['--spacing-1'],
    minHeight: tm.target,
    paddingBlock: spacingVars['--spacing-3'],
    paddingInline: spacingVars['--spacing-4'],
    paddingTop: { default: null, [media.phone]: tm.safeTop },
    paddingInlineStart: { default: null, [media.phone]: spacingVars['--spacing-2'] },
  },
  phoneOnly: {
    display: { default: 'none', [media.phone]: 'contents' },
  },
  sheet: {
    flexGrow: 1,
    minHeight: 0,
    display: 'grid',
    placeItems: 'center',
    padding: spacingVars['--spacing-6'],
    backgroundColor: { default: null, [media.phone]: colorVars['--color-background-surface'] },
    borderStartStartRadius: { default: null, [media.phone]: tm.paneRadius },
    borderStartEndRadius: { default: null, [media.phone]: tm.paneRadius },
    boxShadow: { default: null, [media.phone]: tm.sheetEdge },
    outline: {
      default: null,
      [media.phone]: {
        default: null,
        [media.forcedColors]: `${borderVars['--border-width']} solid CanvasText`,
      },
    },
  },
});
