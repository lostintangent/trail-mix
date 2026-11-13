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
import { ChevronRight, Menu, type LucideIcon } from 'lucide-react';
import { memo, useId, type ReactNode } from 'react';
import { media, tm } from '../../../app/theme/tokens.stylex.ts';
import { PhoneIsland } from './PhoneIsland.tsx';
import {
  ConversationList,
  ConversationListSkeleton,
  type Listed,
  type SelectBy,
  type Selection,
} from '../../conversations/index.ts';
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
 * The conversation list's sheet, under the view's icon, title and unread count. On a desktop the
 * whole pane is the sheet, and collapsed to its rail it keeps only a way to open it again. On a
 * phone the title sits on the desk, the sheet starts below it, and the way back to the folders
 * floats at the bottom with the pane's other actions.
 */
export function ListPane({
  id,
  icon,
  title,
  unread,
  offline,
  scope,
  below,
  list,
  viewIn,
  listKey,
  conversations,
  isUpdating,
  marks,
  stamps,
  selves,
  selection,
  isPicking,
  onSelect,
  onLongPress,
  onPick,
  onSwipe,
  onAhead,
  picked,
  onShown,
  isCollapsed,
  onExpand,
  onShowFolders,
  island,
  actions,
}: {
  id: string;
  /** The view's icon, the one the sidebar shows for it. */
  icon: LucideIcon;
  title: string;
  unread: number | undefined;
  /**
   * What the list says in place of the unread count while the device has no network, as mail read
   * then may be old: a word, and more where there's room. The title matters more, so they give way
   * before it does, the more first, though the status still says all of them.
   */
  offline?: { said: string; more?: string };
  /** The one account the view holds, or nothing when it gathers every account. */
  scope: Account | undefined;
  /** What sits under the title, such as the search field on a phone and what a search covers. */
  below?: ReactNode;
  /** A list of the view's own in place of its conversations, as the Outbox lists its sends. */
  list?: ReactNode;
  /** What kind of view the list shows, which says what an empty list means. */
  viewIn: View['in'];
  /** Names the view's list. Another list starts at its top. */
  listKey: string;
  /** The view's whole list, with places not yet fetched empty. Nothing until its first page arrives. */
  conversations: Listed<ConversationSummary> | undefined;
  /** Whether newer rows are on their way. */
  isUpdating: boolean;
  /** What a search matched, marked in each row. */
  marks: Marks;
  /** Each account's stamp color, by account id, where the list mixes accounts. */
  stamps?: ReadonlyMap<string, StampColor>;
  /** The member's own addresses, lowercased. */
  selves: ReadonlySet<string>;
  selection: Selection;
  isPicking: boolean;
  onSelect: (id: ConversationId, by: SelectBy) => void;
  onLongPress: (id: ConversationId) => void;
  onPick: (id: ConversationId) => void;
  onSwipe: (id: ConversationId) => void;
  /** Asks for a conversation the member is about to open, before the click. */
  onAhead?: (id: ConversationId, isPressed: boolean) => void;
  /** While picking on a phone, what the island offers for the conversations picked. */
  picked: ReactNode;
  /** Says which rows the list shows, so the pages they lie on are fetched. */
  onShown: (first: number, last: number, selected: number) => void;
  isCollapsed: boolean;
  onExpand: () => void;
  onShowFolders: () => void;
  /** On a phone, what the island holds after the way to the folders: search, then Write. */
  island?: ReactNode;
  /** What can be done to the folder in view, beside its title. */
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
        <Icon icon={icon} size="md" xstyle={styles.icon} />
        <Heading level={2} id={titleId} xstyle={styles.title}>
          {title}
        </Heading>
        {offline && (
          // Each part wraps whole to a second line its box hides, the last first, where they can't
          // all fit beside the title.
          <span role="status" {...stylex.props(styles.offline)}>
            <span {...stylex.props(styles.offlineDot)} />
            <span {...stylex.props(styles.offlinePart)}>{offline.said}</span>
            {offline.more && (
              <span {...stylex.props(styles.offlinePart)}>{`: ${offline.more}`}</span>
            )}
          </span>
        )}
        {unread ? (
          // Where the count can't fit whole, it moves past a break to a second line its box hides,
          // so it goes before the title gives up a letter.
          <span {...stylex.props(styles.unread, offline !== undefined && styles.besideOffline)}>
            {'\u200b'}
            <span {...stylex.props(styles.unreadText)}>{unread} unread</span>
          </span>
        ) : null}
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
          <Empty viewIn={viewIn} icon={icon} title={title} />
        ) : conversations ? (
          <ConversationList
            label={title}
            listKey={listKey}
            conversations={conversations}
            isUpdating={isUpdating}
            marks={marks}
            stamps={stamps}
            selves={selves}
            selection={selection}
            isPicking={isPicking}
            onSelect={onSelect}
            onLongPress={onLongPress}
            onPick={onPick}
            onSwipe={onSwipe}
            onAhead={onAhead}
            onShown={onShown}
          />
        ) : (
          <ConversationListSkeleton label={title} />
        )}
      </div>
      {isPicking ? (
        <PhoneIsland label="Picked conversations">{picked}</PhoneIsland>
      ) : (
        <PhoneIsland label="Mailbox actions" spans={island !== undefined}>
          <FoldersButton onClick={onShowFolders} />
          {island}
        </PhoneIsland>
      )}
    </section>
  );
}

const FOLDERS_ICON = <Icon icon={Menu} />;

// The island is a phone's, and hidden on wider screens, so it costs nothing as the list changes.
const FoldersButton = memo(function FoldersButton({ onClick }: { onClick: () => void }) {
  return <IconButton label="Folders" icon={FOLDERS_ICON} variant="ghost" onClick={onClick} />;
});

/** What an empty list says, for the kind of view it is, under the view's icon. */
const EMPTY = {
  inbox: {
    title: () => 'No mail yet',
    description: 'Mail from the accounts you connect will gather here, newest first.',
  },
  flagged: {
    title: () => 'Nothing flagged',
    description: 'Mail you flag gathers here, from every account.',
  },
  drafts: {
    title: () => 'No drafts',
    description: 'Messages you start and haven’t sent gather here.',
  },
  folder: {
    title: (name: string) => `${name} is empty`,
    description: 'Mail you move here will show up in this folder.',
  },
  search: {
    title: () => 'No matches',
    description: 'Nothing in any account matches every word you typed.',
  },
} satisfies Record<Exclude<View['in'], 'outbox'>, unknown>;

function Empty({ viewIn, icon, title }: { viewIn: View['in']; icon: LucideIcon; title: string }) {
  // The Outbox lists its own sends, and says when there are none.
  const empty = EMPTY[viewIn === 'outbox' ? 'inbox' : viewIn];
  return (
    <EmptyState
      icon={<Icon icon={icon} size="lg" color="secondary" />}
      title={empty.title(title)}
      description={empty.description}
    />
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
  // A narrow list's header gives up its unread count, then truncates its title, so the
  // conversation's buttons keep their place at its end, at any width and under a finger too.
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
  // The view's icon, level with its title, in the tone of the sidebar's.
  icon: {
    flexShrink: 0,
    alignSelf: 'center',
    color: colorVars['--color-text-secondary'],
  },
  // The folder's own menu, beside its title.
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
  // On a phone the list is the whole screen, and its title is large and bold, as a page's is.
  title: {
    fontSize: {
      default: typeScaleVars['--text-heading-3-size'],
      [media.phone]: typeScaleVars['--text-heading-1-size'],
    },
    lineHeight: {
      default: typeScaleVars['--text-heading-3-leading'],
      [media.phone]: typeScaleVars['--text-heading-1-leading'],
    },
    fontWeight: { default: null, [media.phone]: fontWeightVars['--font-weight-bold'] },
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
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
  // It shrinks far ahead of the title, and one line tall, it shows its count whole or not at all.
  unread: {
    flexShrink: 1_000_000,
    minWidth: 0,
    height: `calc(${typeScaleVars['--text-supporting-size']} * ${typeScaleVars['--text-supporting-leading']})`,
    overflow: 'hidden',
    color: tm.textQuiet,
    fontSize: typeScaleVars['--text-supporting-size'],
    lineHeight: typeScaleVars['--text-supporting-leading'],
  },
  unreadText: {
    display: 'inline-block',
    whiteSpace: 'nowrap',
  },
  // A list that says it's offline says nothing else beside its title.
  besideOffline: {
    display: 'none',
  },
  // As the unread count, it gives way before the title gives up a letter, one line tall.
  offline: {
    flexShrink: 1_000_000,
    minWidth: 0,
    height: `calc(${typeScaleVars['--text-supporting-size']} * ${typeScaleVars['--text-supporting-leading']})`,
    overflow: 'hidden',
    color: tm.textQuiet,
    fontSize: typeScaleVars['--text-supporting-size'],
    lineHeight: typeScaleVars['--text-supporting-leading'],
  },
  offlineDot: {
    display: 'inline-block',
    verticalAlign: 'middle',
    width: tm.statusDot,
    height: tm.statusDot,
    marginInlineEnd: spacingVars['--spacing-1-5'],
    borderRadius: '50%',
    backgroundColor: tm.textQuiet,
    forcedColorAdjust: 'none',
  },
  offlinePart: {
    display: 'inline-block',
    whiteSpace: 'nowrap',
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
      },
    },
    outlineOffset: '-2px',
  },
});
