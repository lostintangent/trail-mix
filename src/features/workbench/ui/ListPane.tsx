import { EmptyState } from '@astryxdesign/core/EmptyState';
import { Heading } from '@astryxdesign/core/Heading';
import { Icon } from '@astryxdesign/core/Icon';
import { IconButton } from '@astryxdesign/core/IconButton';
import {
  borderVars,
  colorVars,
  spacingVars,
  typeScaleVars,
} from '@astryxdesign/core/theme/tokens.stylex';
import * as stylex from '@stylexjs/stylex';
import { ChevronRight, Inbox, Menu } from 'lucide-react';
import { useId } from 'react';
import { media, tm } from '../../../app/theme/tokens.stylex.ts';
import { PhoneIsland } from './PhoneIsland.tsx';
import { ConversationList } from '../../conversations/index.ts';
import type { ConversationId, ConversationSummary, StampColor } from '../../mail/core/index.ts';

/**
 * The conversation list's sheet, under the view's title and its unread count. On a desktop the
 * whole pane is the sheet, and collapsed to its rail it keeps only a way to open it again. On a
 * phone the title sits on the desk, the sheet starts below it, and the way back to the folders
 * floats at the bottom with the pane's other actions.
 */
export function ListPane({
  id,
  title,
  unread,
  conversations,
  stamps,
  selected,
  onSelect,
  isCollapsed,
  onExpand,
  onShowFolders,
}: {
  id: string;
  title: string;
  unread: number | undefined;
  conversations: readonly ConversationSummary[];
  stamps: ReadonlyMap<string, StampColor>;
  selected: ConversationId | undefined;
  onSelect: (id: ConversationId) => void;
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
        <Heading level={2} id={titleId}>
          {title}
        </Heading>
        {unread ? <span {...stylex.props(styles.unread)}>{unread} unread</span> : null}
      </header>
      <div {...stylex.props(styles.sheet, conversations.length === 0 && styles.empty)}>
        {conversations.length === 0 ? (
          <EmptyState
            icon={<Icon icon={Inbox} size="lg" color="secondary" />}
            title="No mail yet"
            description="Mail from the accounts you connect will gather here, newest first."
          />
        ) : (
          <ConversationList
            label={title}
            conversations={conversations}
            stamps={stamps}
            selected={selected}
            onSelect={onSelect}
          />
        )}
      </div>
      <PhoneIsland label="Mailbox actions">
        <IconButton
          label="Folders"
          icon={<Icon icon={Menu} />}
          variant="ghost"
          onClick={onShowFolders}
        />
      </PhoneIsland>
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
  empty: {
    display: 'grid',
    placeItems: 'center',
    padding: spacingVars['--spacing-6'],
  },
  rail: {
    alignItems: 'center',
    paddingBlock: spacingVars['--spacing-2'],
  },
  header: {
    flexShrink: 0,
    display: 'flex',
    alignItems: 'baseline',
    gap: spacingVars['--spacing-2'],
    minHeight: tm.target,
    paddingBlock: spacingVars['--spacing-3'],
    paddingInline: spacingVars['--spacing-4'],
    paddingTop: {
      default: null,
      [media.phone]: `calc(${tm.safeTop} + ${spacingVars['--spacing-2']})`,
    },
  },
  unread: {
    color: tm.textQuiet,
    fontSize: typeScaleVars['--text-supporting-size'],
  },
  sheet: {
    flexGrow: 1,
    minHeight: 0,
    // On a phone the list ends above the island: its height, its padding, and the gap below it.
    paddingBottom: {
      default: null,
      [media.phone]: `calc(${tm.target} + ${spacingVars['--spacing-1']} * 2 + ${spacingVars['--spacing-3']} + ${tm.safeBottom})`,
    },
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
