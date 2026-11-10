import { EmptyState } from '@astryxdesign/core/EmptyState';
import { Heading } from '@astryxdesign/core/Heading';
import { Icon } from '@astryxdesign/core/Icon';
import { IconButton } from '@astryxdesign/core/IconButton';
import {
  borderVars,
  colorVars,
  fontWeightVars,
  radiusVars,
  spacingVars,
  typeScaleVars,
} from '@astryxdesign/core/theme/tokens.stylex';
import * as stylex from '@stylexjs/stylex';
import { ChevronRight, File, FolderOpen, Inbox, Menu, SearchX, Star } from 'lucide-react';
import { useId, type ReactNode } from 'react';
import { media, tm } from '../../../app/theme/tokens.stylex.ts';
import { PhoneIsland } from './PhoneIsland.tsx';
import { ConversationList, type SelectBy, type Selection } from '../../conversations/index.ts';
import type {
  Account,
  ConversationId,
  ConversationSummary,
  Marks,
  StampColor,
  View,
} from '../../mail/core/index.ts';
import { StampDot } from '../../../app/theme/StampDot.tsx';

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
  scope,
  below,
  list,
  viewIn,
  conversations,
  isUpdating,
  marks,
  stamps,
  selection,
  isPicking,
  onSelect,
  onLongPress,
  onSwipe,
  picked,
  onNearEnd,
  isCollapsed,
  onExpand,
  onShowFolders,
  write,
  actions,
}: {
  id: string;
  title: string;
  unread: number | undefined;
  /** The one account the view holds, or nothing when it gathers every account. */
  scope: Account | undefined;
  /** What sits under the title, such as the search field on a phone and what a search covers. */
  below?: ReactNode;
  /** A list of the view's own in place of its conversations, as the Outbox lists its sends. */
  list?: ReactNode;
  /** What kind of view the list shows, which says what an empty list means. */
  viewIn: View['in'];
  /** Nothing until the view's first page arrives. */
  conversations: readonly ConversationSummary[] | undefined;
  /** Whether newer rows are on their way. */
  isUpdating: boolean;
  /** What a search matched, marked in each row. */
  marks: Marks;
  stamps: ReadonlyMap<string, StampColor>;
  selection: Selection;
  isPicking: boolean;
  onSelect: (id: ConversationId, by: SelectBy) => void;
  onLongPress: (id: ConversationId) => void;
  onSwipe: (id: ConversationId) => void;
  /** While picking on a phone, what the island offers for the conversations picked. */
  picked: ReactNode;
  onNearEnd: () => void;
  isCollapsed: boolean;
  onExpand: () => void;
  onShowFolders: () => void;
  /** Starts a new message: at the end of the title on a desktop, and in the island on a phone. */
  write?: ReactNode;
  /** What can be done to the view itself, such as renaming its folder, at the header's end. */
  actions?: ReactNode;
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
        <Heading level={2} id={titleId} xstyle={styles.title}>
          {title}
        </Heading>
        {unread ? <span {...stylex.props(styles.unread)}>{unread} unread</span> : null}
        <span {...stylex.props(styles.scope)}>
          {scope ? (
            <>
              <StampDot stamp={scope.stamp} />
              {scope.name}
            </>
          ) : (
            'All accounts'
          )}
        </span>
        {write && <span {...stylex.props(styles.write)}>{write}</span>}
        {actions && (
          <span role="toolbar" aria-label={title} {...stylex.props(styles.actions)}>
            {actions}
          </span>
        )}
      </header>
      {below && <div {...stylex.props(styles.below)}>{below}</div>}
      <div {...stylex.props(styles.sheet, !list && conversations?.length === 0 && styles.empty)}>
        {list ? (
          list
        ) : conversations?.length === 0 ? (
          <Empty viewIn={viewIn} title={title} />
        ) : conversations ? (
          <ConversationList
            label={title}
            conversations={conversations}
            isUpdating={isUpdating}
            marks={marks}
            stamps={stamps}
            selection={selection}
            isPicking={isPicking}
            onSelect={onSelect}
            onLongPress={onLongPress}
            onSwipe={onSwipe}
            onNearEnd={onNearEnd}
          />
        ) : null}
      </div>
      {isPicking ? (
        <PhoneIsland label="Picked conversations">{picked}</PhoneIsland>
      ) : (
        <PhoneIsland label="Mailbox actions">
          <IconButton
            label="Folders"
            icon={<Icon icon={Menu} />}
            variant="ghost"
            onClick={onShowFolders}
          />
          {write}
        </PhoneIsland>
      )}
    </section>
  );
}

/** What an empty list says, for the kind of view it is. */
const EMPTY = {
  inbox: {
    icon: Inbox,
    title: () => 'No mail yet',
    description: 'Mail from the accounts you connect will gather here, newest first.',
  },
  flagged: {
    icon: Star,
    title: () => 'Nothing flagged',
    description: 'Mail you flag gathers here, from every account.',
  },
  drafts: {
    icon: File,
    title: () => 'No drafts',
    description: 'Messages you start and haven’t sent gather here.',
  },
  folder: {
    icon: FolderOpen,
    title: (name: string) => `${name} is empty`,
    description: 'Mail you move here will show up in this folder.',
  },
  search: {
    icon: SearchX,
    title: () => 'No matches',
    description: 'Nothing in any account matches every word you typed.',
  },
} satisfies Record<Exclude<View['in'], 'outbox'>, unknown>;

function Empty({ viewIn, title }: { viewIn: View['in']; title: string }) {
  // The Outbox lists its own sends, and says when there are none.
  const empty = EMPTY[viewIn === 'outbox' ? 'inbox' : viewIn];
  return (
    <EmptyState
      icon={<Icon icon={empty.icon} size="lg" color="secondary" />}
      title={empty.title(title)}
      description={empty.description}
    />
  );
}

const focusRing = `2px solid ${colorVars['--color-accent']}`;

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
      // The list's focus ring goes around its whole sheet, header and all.
      [stylex.when.descendant(':focus-visible')]: {
        default: focusRing,
        [media.phone]: 'none',
      },
    },
    outlineOffset: '-2px',
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
    paddingTop: {
      default: spacingVars['--spacing-3'],
      [media.phone]: `calc(${tm.safeTop} + ${spacingVars['--spacing-2']})`,
    },
    paddingBottom: {
      default: spacingVars['--spacing-2'],
      [media.phone]: spacingVars['--spacing-3'],
    },
    paddingInline: spacingVars['--spacing-4'],
  },
  // The header's line keeps its height, so a button's extra size reaches into its padding.
  write: {
    display: { default: 'flex', [media.phone]: 'none' },
    alignSelf: 'center',
    marginInlineStart: 'auto',
    marginBlock: `calc(-1 * ${spacingVars['--spacing-2']})`,
  },
  // They follow New message on a desktop, and the account's pill on a phone.
  actions: {
    display: 'flex',
    alignSelf: 'center',
    marginBlock: `calc(-1 * ${spacingVars['--spacing-2']})`,
  },
  below: {
    flexShrink: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: spacingVars['--spacing-2'],
    paddingInline: spacingVars['--spacing-4'],
    paddingBottom: spacingVars['--spacing-2'],
  },
  // The view's name stays modest beside the list on a desktop, and leads the screen on a phone.
  title: {
    fontSize: {
      default: typeScaleVars['--text-heading-3-size'],
      [media.phone]: typeScaleVars['--text-heading-2-size'],
    },
    lineHeight: {
      default: typeScaleVars['--text-heading-3-leading'],
      [media.phone]: typeScaleVars['--text-heading-2-leading'],
    },
  },
  // On a phone, whose list is the whole screen, a chip at the header's end says whose mail it is.
  scope: {
    display: { default: 'none', [media.phone]: 'inline-flex' },
    alignItems: 'center',
    alignSelf: 'center',
    gap: spacingVars['--spacing-1-5'],
    marginInlineStart: 'auto',
    paddingBlock: spacingVars['--spacing-0-5'],
    paddingInline: spacingVars['--spacing-2'],
    borderRadius: radiusVars['--radius-full'],
    boxShadow: `0 0 0 1px ${colorVars['--color-border']}`,
    outline: { default: null, [media.forcedColors]: '1px solid CanvasText' },
    color: colorVars['--color-text-primary'],
    fontSize: typeScaleVars['--text-supporting-size'],
    fontWeight: fontWeightVars['--font-weight-semibold'],
    whiteSpace: 'nowrap',
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
    // On a desktop the sheet is the pane's lower part, and on a phone it rises from the bottom.
    borderStartStartRadius: { default: 0, [media.phone]: tm.paneRadius },
    borderStartEndRadius: { default: 0, [media.phone]: tm.paneRadius },
    borderEndStartRadius: { default: tm.paneRadius, [media.phone]: 0 },
    borderEndEndRadius: { default: tm.paneRadius, [media.phone]: 0 },
    boxShadow: { default: null, [media.phone]: tm.sheetEdge },
    outline: {
      default: null,
      [media.phone]: {
        default: null,
        [media.forcedColors]: `${borderVars['--border-width']} solid CanvasText`,
        [stylex.when.descendant(':focus-visible')]: focusRing,
      },
    },
    outlineOffset: '-2px',
  },
});
