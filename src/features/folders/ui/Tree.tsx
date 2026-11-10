import { Icon } from '@astryxdesign/core/Icon';
import {
  colorVars,
  durationVars,
  fontWeightVars,
  radiusVars,
  spacingVars,
  typeScaleVars,
} from '@astryxdesign/core/theme/tokens.stylex';
import * as stylex from '@stylexjs/stylex';
import { ChevronRight, type LucideIcon } from 'lucide-react';
import { Suspense, useState, type ReactNode } from 'react';
import { StampDot } from '../../../app/theme/StampDot.tsx';
import { media, tm } from '../../../app/theme/tokens.stylex.ts';
import type { Command } from '../../commands/index.ts';
import type { Account, Folder, FolderRef, View } from '../../mail/core/index.ts';
import type { FolderEdit } from './commands.ts';
import { foldKey, type Foldable } from './folds.ts';
import { ActionsMenu, NameField, preloadActionsMenu } from './lazy.ts';
import { MoreButton } from './MoreButton.tsx';
import { folderName } from './name.ts';
import { folderTree, holds, unreadInAccount, unreadWithin, type FolderNode } from './tree.ts';
import { folderIcon, UNIFIED_VIEWS, type ViewCounts } from './views.ts';

/**
 * The sidebar's tree: the unified views, then each account under its stamp, with its folders. Every
 * line keeps room at its end for its menu, so counts line up whether a line has one or not, and
 * accounts and folders with folders inside fold away under a chevron.
 */

/** The views that gather mail across every account, at the top of the tree. */
export function ViewRows({
  view,
  counts,
  onSelect,
}: {
  view: View;
  counts: ViewCounts;
  onSelect: (view: View) => void;
}) {
  return (
    <ul {...stylex.props(styles.rows)}>
      {UNIFIED_VIEWS.map(({ in: unified, label, icon }) => (
        <li key={unified}>
          <Row
            label={label}
            icon={icon}
            count={counts[unified]}
            isCountUnread={unified === 'inbox'}
            isSelected={view.in === unified}
            onSelect={() => onSelect({ in: unified })}
          />
        </li>
      ))}
    </ul>
  );
}

/**
 * An account: its stamp and name, which fold its folders away and back, with its menu at the end.
 * Folded, it shows the unread mail in its folders.
 */
export function AccountSection({
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
  const editingHere =
    editing?.do === 'create'
      ? editing.account.id === account.id
      : editing?.folder.account === account.id;
  // Naming a folder unfolds whatever it's in, for as long as it's named.
  const isOpen = !folds.has(foldKey({ account: account.id })) || editingHere;
  const holdsView = view.in === 'folder' && view.folder.account === account.id;
  const unread = unreadInAccount(nodes);
  const hasUnreadInbox = own.some(({ role, unread }) => role === 'inbox' && unread > 0);
  return (
    <section aria-label={account.name} {...stylex.props(styles.account)}>
      <Line
        menu={
          <RowMenu label={`More for ${account.name}`} actions={() => accountActions(account)} />
        }
      >
        <h2 {...stylex.props(styles.accountHeading)}>
          <button
            type="button"
            aria-expanded={isOpen}
            onClick={() => onFold({ account: account.id })}
            {...stylex.props(styles.row, styles.accountRow, !isOpen && holdsView && lift.holding)}
          >
            <Chevron isOpen={isOpen} />
            <span {...stylex.props(styles.stampBox)}>
              <StampDot stamp={account.stamp} />
            </span>
            <span {...stylex.props(styles.label, styles.accountName)}>{account.name}</span>
            {!isOpen && unread > 0 && <Count count={unread} isUnread={hasUnreadInbox} />}
          </button>
        </h2>
      </Line>
      <Folding isOpen={isOpen}>
        <FolderRows
          nodes={nodes}
          depth={0}
          view={view}
          onSelect={onSelect}
          folds={folds}
          onFold={onFold}
          editing={
            editing?.do === 'create' && editing.account.id !== account.id ? undefined : editing
          }
          folders={own}
          onEdited={onEdited}
          folderActions={folderActions}
          account={account}
        />
      </Folding>
    </section>
  );
}

/**
 * An account's folders, each one followed by the folders inside it, a step further in. A folder
 * being renamed shows its name in a field, and a new one's field leads the folders it will join.
 */
function FolderRows({
  nodes,
  depth,
  view,
  onSelect,
  folds,
  onFold,
  editing,
  folders,
  onEdited,
  folderActions,
  account,
  parent,
}: {
  nodes: FolderNode[];
  depth: number;
  view: View;
  onSelect: (view: View) => void;
  folds: ReadonlySet<string>;
  onFold: (what: Foldable) => void;
  editing: FolderEdit | undefined;
  /** The account's folders, whose names a new name can't take beside them. */
  folders: readonly Folder[];
  onEdited: (name: string | undefined) => void;
  folderActions: (folder: Folder) => readonly Command[];
  account: Account;
  /** The folder these sit inside, if any. */
  parent?: Folder;
}) {
  const isCreatingHere = editing?.do === 'create' && editing.parent?.path === parent?.path;
  // A new folder is named where the member's own folders sit: first inside a folder, and at the
  // top of an account, before Junk and Trash.
  const bins = nodes.findIndex(({ folder }) => folder.role === 'junk' || folder.role === 'trash');
  const fieldAt = parent ? 0 : bins < 0 ? nodes.length : bins;
  const field = isCreatingHere && (
    <li key="new folder">
      <Suspense>
        <NameField
          label={`Name of the new folder in ${parent ? folderName(parent) : account.name}`}
          depth={depth}
          place={{ folders, parent: parent?.path, delimiter: parent?.delimiter }}
          onDone={onEdited}
        />
      </Suspense>
    </li>
  );
  const row = (node: FolderNode) => {
    const { folder, children } = node;
    const isRenaming = editing?.do === 'rename' && editing.folder.path === folder.path;
    const isSelected = view.in === 'folder' && isFolder(view.folder, folder);
    const isParent = editing?.do === 'create' && editing.parent?.path === folder.path;
    const canFold = children.length > 0;
    // Naming a folder inside it unfolds it, for as long as the folder is named.
    const isEditingInside =
      editing !== undefined &&
      (editing.do === 'create'
        ? editing.parent !== undefined && holds(node, editing.parent.path)
        : holds(node, editing.folder.path) && editing.folder.path !== folder.path);
    const isOpen = !folds.has(foldKey(folder)) || isEditingInside;
    const holdsView =
      !isOpen &&
      view.in === 'folder' &&
      view.folder.account === folder.account &&
      holds(node, view.folder.path);
    const name = folderName(folder);
    return (
      <li key={folder.path}>
        {isRenaming ? (
          <Suspense>
            <NameField
              label={`New name for ${name}`}
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
          <Line
            menu={<RowMenu label={`More for ${name}`} actions={() => folderActions(folder)} />}
            fold={
              canFold && (
                <button
                  type="button"
                  aria-label={`${isOpen ? 'Fold' : 'Unfold'} ${name}`}
                  aria-expanded={isOpen}
                  onClick={() => onFold(folder)}
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
              count={isOpen ? folder.unread : unreadWithin(node)}
              isCountUnread={folder.role === 'inbox'}
              isSelected={isSelected}
              isHolding={holdsView}
              onSelect={() =>
                onSelect({ in: 'folder', folder: { account: folder.account, path: folder.path } })
              }
              onFold={canFold ? (open) => open !== isOpen && onFold(folder) : undefined}
            />
          </Line>
        )}
        {(canFold || isParent) && (
          <Folding isOpen={isOpen || isParent}>
            <FolderRows
              nodes={children}
              depth={depth + 1}
              view={view}
              onSelect={onSelect}
              folds={folds}
              onFold={onFold}
              editing={editing}
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
  return (
    <ul {...stylex.props(styles.rows, depth > 0 && styles.inside)}>
      {nodes.slice(0, fieldAt).map(row)}
      {field}
      {nodes.slice(fieldAt).map(row)}
    </ul>
  );
}

const isFolder = (ref: FolderRef, folder: Folder) =>
  ref.account === folder.account && ref.path === folder.path;

/**
 * One line of the tree: what it opens or folds, a chevron over its start when it folds, and its
 * menu over its end, so a selected line lifts as one piece.
 */
function Line({
  fold,
  menu,
  children,
}: {
  fold?: ReactNode;
  menu?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div {...stylex.props(styles.line)}>
      {children}
      {fold}
      {menu && <span {...stylex.props(styles.menu)}>{menu}</span>}
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
 * A row's `…`, which loads its menu only once pressed, and keeps it after that. Until then it's a
 * plain button, so a sidebar of many folders costs little to draw.
 */
function RowMenu({ label, actions }: { label: string; actions: () => readonly Command[] }) {
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
  if (!isWanted) return button;
  return (
    <Suspense fallback={button}>
      <ActionsMenu label={label} actions={actions} />
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
  onSelect,
  onFold,
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
  onSelect: () => void;
  /** Folds or unfolds it, as the arrow keys ask, where it has folders inside. */
  onFold?: (isOpen: boolean) => void;
}) {
  return (
    <button
      type="button"
      aria-current={isSelected ? 'page' : undefined}
      onClick={onSelect}
      onKeyDown={
        onFold &&
        ((event) => {
          if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
          event.preventDefault();
          onFold(event.key === 'ArrowRight');
        })
      }
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
