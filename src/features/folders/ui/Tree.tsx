import { Icon } from '@astryxdesign/core/Icon';
import { Skeleton } from '@astryxdesign/core/Skeleton';
import {
  colorVars,
  durationVars,
  focusVars,
  fontWeightVars,
  radiusVars,
  spacingVars,
  typeScaleVars,
} from '@astryxdesign/core/theme/tokens.stylex';
import * as stylex from '@stylexjs/stylex';
import { ChevronRight, type LucideIcon } from 'lucide-react';
import { memo, Suspense, useReducer, useState, type ReactNode, type SyntheticEvent } from 'react';
import { Pending, TextSkeleton } from '../../../app/theme/Pending.tsx';
import { StampDot } from '../../../app/theme/StampDot.tsx';
import { media, tm } from '../../../app/theme/tokens.stylex.ts';
import type { Command } from '../../commands/index.ts';
import type { Account, Folder, View } from '../../mail/core/index.ts';
import type { FolderEdit } from './commands.ts';
import type { Foldable } from './folds.ts';
import { ActionsMenu, NameField, preloadActionsMenu } from './lazy.ts';
import { MoreButton } from './MoreButton.tsx';
import { folderName } from './name.ts';
import {
  accountLine,
  folderLine,
  folderTree,
  newFolderAt,
  type FolderNode,
  type TreeState,
} from './tree.ts';
import { folderIcon, UNIFIED_VIEWS, type ViewCounts } from './views.ts';

/**
 * The sidebar's tree: the unified views, then each account under its stamp, with its folders. Every
 * line keeps room at its end for its menu, so counts line up whether a line has one or not, and
 * accounts and folders with folders inside fold away under a chevron. Each line is drawn again only
 * as what it shows changes, so a count changing redraws only the lines it changes.
 */

/** The views that gather mail across every account, at the top of the tree. */
export const ViewRows = memo(function ViewRows({
  view,
  isViewHere,
  counts,
  onSelect,
}: {
  view: View;
  /** Whether a line of the tree lifts for the view. When none does, the first is its Tab stop. */
  isViewHere: boolean;
  counts: ViewCounts;
  onSelect: (view: View) => void;
}) {
  return (
    <ul {...stylex.props(styles.rows)}>
      {UNIFIED_VIEWS.map((unified, at) => (
        <li key={unified.in}>
          <ViewLine
            unified={unified}
            count={counts[unified.in]}
            isSelected={view.in === unified.in}
            isStop={view.in === unified.in || (!isViewHere && at === 0)}
            onSelect={onSelect}
          />
        </li>
      ))}
    </ul>
  );
});

const ViewLine = memo(function ViewLine({
  unified: { in: unified, label, icon },
  count,
  isSelected,
  isStop,
  onSelect,
}: {
  unified: (typeof UNIFIED_VIEWS)[number];
  count: number | undefined;
  isSelected: boolean;
  isStop: boolean;
  onSelect: (view: View) => void;
}) {
  return (
    <Row
      label={label}
      icon={icon}
      count={count}
      isCountUnread={unified === 'inbox'}
      isSelected={isSelected}
      isStop={isStop}
      onSelect={() => onSelect({ in: unified })}
    />
  );
});

/**
 * An account: its stamp and name, which fold its folders away and back, with its menu at the end.
 * Folded, it shows the unread mail in its folders.
 */
export const AccountSection = memo(function AccountSection({
  account,
  folders,
  view,
  onSelect,
  folds,
  onFold,
  editing,
  onEdited,
  folderActions,
  accountActions,
}: {
  account: Account;
  folders: readonly Folder[];
  view: View;
  onSelect: (view: View) => void;
  folds: ReadonlySet<string>;
  onFold: (what: Foldable) => void;
  editing: FolderEdit | undefined;
  onEdited: (name: string | undefined) => void;
  folderActions: (folder: Folder) => readonly Command[];
  accountActions: (account: Account) => readonly Command[];
}) {
  const own = folders.filter((folder) => folder.account === account.id);
  const nodes = folderTree(own);
  const state = { view, folds, editing };
  const { isListing, ...line } = accountLine(account, nodes, state);
  return (
    <section aria-label={account.name} {...stylex.props(styles.account)}>
      <AccountLine {...line} account={account} onFold={onFold} accountActions={accountActions} />
      <Folding isOpen={line.isOpen}>
        {isListing && <FolderSkeletons account={account} />}
        <FolderRows
          nodes={nodes}
          depth={0}
          state={state}
          onSelect={onSelect}
          onFold={onFold}
          folders={own}
          onEdited={onEdited}
          folderActions={folderActions}
          account={account}
        />
      </Folding>
    </section>
  );
});

/** An account's own line: its stamp and name, which fold its folders away and back, and its menu. */
const AccountLine = memo(function AccountLine({
  account,
  isOpen,
  isHolding,
  unread,
  isUnreadInInbox,
  onFold,
  accountActions,
}: {
  account: Account;
  isOpen: boolean;
  /** Whether it's folded around the view, which then lifts it and makes it the tree's Tab stop. */
  isHolding: boolean;
  /** The unread mail folded away under it, so none while it's open. */
  unread: number;
  /** Whether any of that is in its Inbox, which then counts in the accent. */
  isUnreadInInbox: boolean;
  onFold: (what: Foldable) => void;
  accountActions: (account: Account) => readonly Command[];
}) {
  const trouble = troubleOf(account);
  return (
    <Line menu={{ label: `More for ${account.name}`, actions: () => accountActions(account) }}>
      <h2 {...stylex.props(styles.accountHeading)}>
        <button
          type="button"
          tabIndex={isHolding ? 0 : -1}
          aria-expanded={isOpen}
          onClick={() => onFold({ account: account.id })}
          data-row={1}
          data-fold
          {...stylex.props(styles.row, styles.accountRow, isHolding && lift.holding)}
        >
          <Chevron isOpen={isOpen} />
          <span {...stylex.props(styles.stampBox)}>
            <StampDot stamp={account.stamp} />
          </span>
          <span {...stylex.props(styles.label, styles.accountName)}>{account.name}</span>
          {trouble && (
            <>
              {' '}
              <span {...stylex.props(styles.trouble)}>{trouble}</span>
            </>
          )}
          {unread > 0 && <Count count={unread} isUnread={isUnreadInInbox} />}
        </button>
      </h2>
    </Line>
  );
});

/**
 * What an account that needs the member says on its line, and the rail's tooltip for its stamp:
 * that its sign-in ran out, or that its servers can't be reached. Its menu offers the fix. Nothing
 * else about an account's mail is said, since a member should simply trust it's current.
 */
export function troubleOf({ status }: Account): string | undefined {
  if (status === 'needs-sign-in') return 'Sign in again';
  if (status === 'error') return 'Can’t reach';
  return undefined;
}

/** Folder lines on their way, as a new account's first sync lists them, in their shape. */
function FolderSkeletons({ account }: { account: Account }) {
  return (
    <Pending label={`Listing ${account.name}’s folders`} holdsPlace={false}>
      {SKELETON_WIDTHS.map((width, line) => (
        <div
          key={line}
          aria-hidden
          {...stylex.props(styles.row, styles.folderRow(0), styles.pending)}
        >
          <Skeleton width="16px" height="16px" radius={1} index={line} />
          <TextSkeleton width={width} index={line} />
        </div>
      ))}
    </Pending>
  );
}

/** The lengths of the folder names the skeleton lines stand in for: an Inbox, then a few others. */
const SKELETON_WIDTHS = ['34%', '42%', '28%', '38%'] as const;

/**
 * An account's folders, each one followed by the folders inside it, a step further in. A folder
 * being renamed shows its name in a field, and a new one's field leads the folders it will join.
 */
function FolderRows({
  nodes,
  depth,
  state,
  onSelect,
  onFold,
  folders,
  onEdited,
  folderActions,
  account,
  parent,
}: {
  nodes: FolderNode[];
  depth: number;
  state: TreeState;
  onSelect: (view: View) => void;
  onFold: (what: Foldable) => void;
  /** The account's folders, whose names a new name can't take beside them. */
  folders: readonly Folder[];
  onEdited: (name: string | undefined) => void;
  folderActions: (folder: Folder) => readonly Command[];
  account: Account;
  /** The folder these sit inside, if any. */
  parent?: Folder;
}) {
  const row = (node: FolderNode) => {
    const { folder, children } = node;
    const { isRenaming, holdsNewFolder, ...line } = folderLine(node, state);
    return (
      <li key={folder.path}>
        {isRenaming ? (
          <Suspense>
            <NameField
              label={`New name for ${folderName(folder)}`}
              initial={folder.name}
              depth={depth}
              place={{
                folders,
                parent: folder.parent,
                delimiter: folder.delimiter,
                renaming: folder,
              }}
              onDone={onEdited}
            />
          </Suspense>
        ) : (
          <FolderLine
            {...line}
            folder={folder}
            depth={depth}
            onSelect={onSelect}
            onFold={onFold}
            folderActions={folderActions}
          />
        )}
        {(line.canFold || holdsNewFolder) && (
          <Folding isOpen={line.isOpen}>
            <FolderRows
              nodes={children}
              depth={depth + 1}
              state={state}
              onSelect={onSelect}
              onFold={onFold}
              folders={folders}
              onEdited={onEdited}
              folderActions={folderActions}
              account={account}
              parent={folder}
            />
          </Folding>
        )}
      </li>
    );
  };
  // One list of keyed lines, so a line keeps its place as the new folder's field comes and goes.
  const lines = nodes.map(row);
  const fieldAt = newFolderAt(nodes, state.editing, account.id, parent);
  if (fieldAt !== undefined) {
    lines.splice(
      fieldAt,
      0,
      <li key="new folder">
        <Suspense>
          <NameField
            label={`Name of the new folder in ${parent ? folderName(parent) : account.name}`}
            depth={depth}
            place={{ folders, parent: parent?.path, delimiter: parent?.delimiter }}
            onDone={onEdited}
          />
        </Suspense>
      </li>,
    );
  }
  return <ul {...stylex.props(styles.rows, depth > 0 && styles.inside)}>{lines}</ul>;
}

/** A folder's own line: what opens it, the chevron that folds what's inside it, and its menu. */
const FolderLine = memo(function FolderLine({
  folder,
  depth,
  count,
  canFold,
  isOpen,
  isSelected,
  isHolding,
  onSelect,
  onFold,
  folderActions,
}: {
  folder: Folder;
  depth: number;
  /** Its unread mail, with that of the folders inside it while they're folded away. */
  count: number;
  /** Whether it has folders inside it to fold away. */
  canFold: boolean;
  isOpen: boolean;
  isSelected: boolean;
  /** Whether it's folded around the view, which then lifts it instead. */
  isHolding: boolean;
  onSelect: (view: View) => void;
  onFold: (what: Foldable) => void;
  folderActions: (folder: Folder) => readonly Command[];
}) {
  const name = folderName(folder);
  return (
    <Line
      menu={{ label: `More for ${name}`, actions: () => folderActions(folder) }}
      fold={
        canFold && (
          <button
            type="button"
            tabIndex={-1}
            aria-label={`${isOpen ? 'Fold' : 'Unfold'} ${name}`}
            aria-expanded={isOpen}
            onClick={() => onFold(folder)}
            data-fold
            {...stylex.props(styles.fold, styles.foldAt(depth))}
          >
            <Chevron isOpen={isOpen} />
          </button>
        )
      }
    >
      <Row
        label={name}
        icon={folderIcon(folder)}
        depth={depth}
        count={count}
        isCountUnread={folder.role === 'inbox'}
        isSelected={isSelected}
        isHolding={isHolding}
        isStop={isSelected || isHolding}
        onSelect={() =>
          onSelect({ in: 'folder', folder: { account: folder.account, path: folder.path } })
        }
      />
    </Line>
  );
});

/**
 * One line of the tree: what it opens or folds, a chevron over its start when it folds, and its
 * menu over its end, so a selected line lifts as one piece. Shift+F10, the menu key and a right
 * click open its menu too, as its `…` does.
 */
function Line({
  fold,
  menu,
  children,
}: {
  fold?: ReactNode;
  menu?: { label: string; actions: () => readonly Command[] };
  children: ReactNode;
}) {
  // Asking again while the menu is open, as its own keys and clicks passing up through here do,
  // leaves it as it is.
  const [asked, ask] = useReducer((times: number) => times + 1, 0);
  const openMenu = (event: SyntheticEvent) => {
    event.preventDefault();
    ask();
  };
  return (
    <div
      data-line
      {...(menu && {
        onKeyDown: (event) =>
          ((event.key === 'F10' && event.shiftKey) || event.key === 'ContextMenu') &&
          openMenu(event),
        onContextMenu: openMenu,
      })}
      {...stylex.props(styles.line)}
    >
      {children}
      {fold}
      {menu && (
        <span {...stylex.props(styles.menu)}>
          <RowMenu {...menu} asked={asked} />
        </span>
      )}
    </div>
  );
}

/** What folds away under a line, which slides shut and opens again. */
function Folding({ isOpen, children }: { isOpen: boolean; children: ReactNode }) {
  return (
    <div
      aria-hidden={!isOpen || undefined}
      inert={!isOpen}
      {...stylex.props(styles.folding, !isOpen && styles.folded)}
    >
      <div {...stylex.props(styles.foldingInner)}>{children}</div>
    </div>
  );
}

function Chevron({ isOpen }: { isOpen: boolean }) {
  return (
    <Icon icon={ChevronRight} size="sm" xstyle={[styles.chevron, isOpen && styles.chevronOpen]} />
  );
}

/**
 * A row's `…`, which loads its menu only once pressed or asked for by its line, and keeps it after
 * that. Until then it's a plain button, so a sidebar of many folders costs little to draw.
 */
function RowMenu({
  label,
  actions,
  asked,
}: {
  label: string;
  actions: () => readonly Command[];
  /** How many times its line has asked for it. */
  asked: number;
}) {
  const [isWanted, setWanted] = useState(false);
  const button = (
    <MoreButton
      label={label}
      aria-expanded={isWanted}
      onPointerEnter={() => void preloadActionsMenu()}
      onFocus={() => void preloadActionsMenu()}
      onClick={() => setWanted(true)}
    />
  );
  if (!isWanted && asked === 0) return button;
  return (
    <Suspense fallback={button}>
      <ActionsMenu label={label} actions={actions} asked={asked} />
    </Suspense>
  );
}

function Count({ count, isUnread }: { count: number; isUnread: boolean }) {
  return <span {...stylex.props(styles.count, isUnread && styles.countUnread)}>{count}</span>;
}

function Row({
  label,
  icon,
  depth,
  count,
  isCountUnread,
  isSelected,
  isHolding = false,
  isStop,
  onSelect,
}: {
  label: string;
  icon: LucideIcon;
  /** How many folders a folder sits inside, or nothing for a unified view. */
  depth?: number;
  count: number | undefined;
  /** Unread mail in an Inbox counts in the accent. Every other count is quiet. */
  isCountUnread: boolean;
  isSelected: boolean;
  /** Whether it's folded around the view, which then lifts it instead. */
  isHolding?: boolean;
  /** Whether it's the tree's one Tab stop: the line that lifts, or the first when none does. */
  isStop: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      tabIndex={isStop ? 0 : -1}
      aria-current={isSelected ? 'page' : undefined}
      onClick={onSelect}
      // A unified view sits at the top, as an account does, and its folders a level in.
      data-row={depth === undefined ? 1 : depth + 2}
      {...stylex.props(
        styles.row,
        depth !== undefined && styles.folderRow(depth),
        isSelected && lift.selected,
        isHolding && lift.holding,
      )}
    >
      <Icon icon={icon} size="sm" />
      <span {...stylex.props(styles.label)}>{label}</span>
      {count ? <Count count={count} isUnread={isCountUnread} /> : null}
    </button>
  );
}

// The tree's columns: a view's icon, then its label. An account's chevron sits in the icon's column
// and its stamp in the next, which is where a folder's icon sits, after the column its own chevron
// takes. Each folder inside another starts a column further in.
const ICON = '1rem';
const STEP = `calc(${ICON} + ${spacingVars['--spacing-1']})`;

const styles = stylex.create({
  rows: {
    display: 'flex',
    flexDirection: 'column',
    gap: spacingVars['--spacing-0-5'],
    margin: 0,
    padding: 0,
    listStyle: 'none',
  },
  inside: {
    marginTop: spacingVars['--spacing-0-5'],
  },
  // Folding slides what's inside shut by its own height, and keeps room for a lifted row's edge.
  folding: {
    display: 'grid',
    gridTemplateRows: '1fr',
    transitionProperty: 'grid-template-rows',
    transitionDuration: { default: durationVars['--duration-fast'], [media.reducedMotion]: '0s' },
  },
  folded: {
    gridTemplateRows: '0fr',
  },
  foldingInner: {
    minHeight: 0,
    overflow: 'hidden',
    padding: '1px',
    margin: '-1px',
  },
  line: {
    position: 'relative',
  },
  menu: {
    position: 'absolute',
    insetBlock: 0,
    insetInlineEnd: 0,
    display: 'flex',
    alignItems: 'center',
  },
  account: {
    marginTop: spacingVars['--spacing-3'],
  },
  // Every line keeps room at its end for a menu, so counts line up whether a line has one or not.
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: spacingVars['--spacing-2'],
    width: '100%',
    minHeight: tm.target,
    margin: 0,
    paddingInlineStart: spacingVars['--spacing-2'],
    paddingInlineEnd: tm.target,
    borderWidth: 0,
    borderRadius: radiusVars['--radius-element'],
    backgroundColor: {
      default: 'transparent',
      ':hover': { default: null, '@media (hover: hover)': colorVars['--color-overlay-hover'] },
    },
    color: colorVars['--color-text-secondary'],
    font: 'inherit',
    fontSize: typeScaleVars['--text-body-size'],
    textAlign: 'start',
    cursor: 'pointer',
    outline: {
      default: null,
      // The focus ring every Astryx control draws.
      ':focus-visible': `${focusVars['--focus-outline-width']} ${focusVars['--focus-outline-style']} ${focusVars['--focus-outline-color']}`,
    },
    outlineOffset: '-2px',
  },
  // A folder's icon starts after the column its chevron takes, a step further in for each folder
  // it sits inside. Its line still spans the sidebar, so a selected one lifts as wide as the views.
  folderRow: (depth: number) => ({
    paddingInlineStart: `calc(${spacingVars['--spacing-2']} + ${depth + 1} * ${STEP})`,
  }),
  accountRow: {
    gap: spacingVars['--spacing-1'],
  },
  // The chevron of a folder that folds, over the start of its line: the line's padding and the
  // chevron's column, or a full target under a finger.
  fold: {
    position: 'absolute',
    insetBlock: 0,
    display: 'flex',
    alignItems: 'center',
    width: {
      default: `calc(${spacingVars['--spacing-2']} + ${STEP})`,
      [media.coarse]: tm.target,
    },
    padding: 0,
    paddingInlineStart: spacingVars['--spacing-2'],
    borderWidth: 0,
    borderRadius: radiusVars['--radius-element'],
    backgroundColor: 'transparent',
    color: {
      default: tm.textQuiet,
      ':hover': { default: null, '@media (hover: hover)': colorVars['--color-text-primary'] },
    },
    cursor: 'pointer',
    outline: {
      default: null,
      // The focus ring every Astryx control draws.
      ':focus-visible': `${focusVars['--focus-outline-width']} ${focusVars['--focus-outline-style']} ${focusVars['--focus-outline-color']}`,
    },
    outlineOffset: '-2px',
  },
  foldAt: (depth: number) => ({
    insetInlineStart: `calc(${depth} * ${STEP})`,
  }),
  chevron: {
    flexShrink: 0,
    transitionProperty: 'transform',
    transitionDuration: { default: durationVars['--duration-fast'], [media.reducedMotion]: '0s' },
  },
  chevronOpen: {
    transform: 'rotate(90deg)',
  },
  // The stamp sits in the column a folder's icon does.
  stampBox: {
    display: 'grid',
    placeItems: 'center',
    flexShrink: 0,
    width: ICON,
    marginInlineEnd: spacingVars['--spacing-1'],
  },
  accountHeading: {
    margin: 0,
    font: 'inherit',
  },
  accountName: {
    color: tm.textQuiet,
    fontSize: typeScaleVars['--text-supporting-size'],
    fontWeight: fontWeightVars['--font-weight-semibold'],
    lineHeight: typeScaleVars['--text-supporting-leading'],
    letterSpacing: '0.06em',
    textTransform: 'uppercase',
  },
  label: {
    flexGrow: 1,
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  count: {
    flexShrink: 0,
    color: tm.textQuiet,
    fontSize: typeScaleVars['--text-supporting-size'],
    fontWeight: fontWeightVars['--font-weight-semibold'],
    fontVariantNumeric: 'tabular-nums',
  },
  countUnread: {
    color: colorVars['--color-text-accent'],
  },
  // An account that needs the member says so in the error's ink, whole, while its name gives way.
  trouble: {
    flexShrink: 0,
    color: colorVars['--color-text-error'],
    fontSize: typeScaleVars['--text-supporting-size'],
    fontWeight: fontWeightVars['--font-weight-semibold'],
  },
  // A line on its way takes a folder line's place and nothing from the pointer.
  pending: {
    cursor: 'default',
    pointerEvents: 'none',
  },
});

/** How a line rises from the desk onto a pane: as the view, or folded around it. */
export const lift = stylex.create({
  // Selection lifts instead of tinting: the current view rises from the desk onto a pane.
  selected: {
    backgroundColor: {
      default: colorVars['--color-background-surface'],
      ':hover': colorVars['--color-background-surface'],
      [media.forcedColors]: 'Highlight',
    },
    boxShadow: `0 0 0 1px ${colorVars['--color-border']}`,
    color: {
      default: colorVars['--color-text-primary'],
      [media.forcedColors]: 'HighlightText',
    },
    fontWeight: fontWeightVars['--font-weight-semibold'],
    forcedColorAdjust: 'none',
  },
  // Folded around the view, a line rises with it, so the member still sees where they are.
  holding: {
    backgroundColor: {
      default: colorVars['--color-background-surface'],
      ':hover': colorVars['--color-background-surface'],
    },
    boxShadow: `0 0 0 1px ${colorVars['--color-border']}`,
    color: colorVars['--color-text-primary'],
  },
});
