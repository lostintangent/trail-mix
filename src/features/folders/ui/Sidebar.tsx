import { Button } from '@astryxdesign/core/Button';
import { Icon } from '@astryxdesign/core/Icon';
import { IconButton } from '@astryxdesign/core/IconButton';
import {
  colorVars,
  fontWeightVars,
  radiusVars,
  spacingVars,
  typeScaleVars,
} from '@astryxdesign/core/theme/tokens.stylex';
import { Tooltip } from '@astryxdesign/core/Tooltip';
import * as stylex from '@stylexjs/stylex';
import {
  File,
  FolderPlus,
  Inbox,
  MailPlus,
  Send,
  Settings2,
  Star,
  Users,
  type LucideIcon,
} from 'lucide-react';
import { memo, Suspense, type ReactNode } from 'react';
import { media, tm } from '../../../app/theme/tokens.stylex.ts';
import type { Account, Folder, FolderRef, View } from '../../mail/core/index.ts';
import { StampDot } from '../../../app/theme/StampDot.tsx';
import type { FolderEdit } from './commands.ts';
import { NameField } from './lazy.ts';
import { folderName } from './name.ts';
import { folderTree, type FolderNode } from './tree.ts';

type UnifiedView = Exclude<View['in'], 'folder' | 'search'>;

/** What each unified view counts: unread mail in Inbox, drafts, and messages waiting to leave. */
export type ViewCounts = Partial<Record<UnifiedView, number>>;

/** The views that gather mail across every account, and which count each one shows. */
export const UNIFIED_VIEWS = [
  { in: 'inbox', label: 'Inbox', icon: Inbox },
  { in: 'flagged', label: 'Flagged', icon: Star },
  { in: 'drafts', label: 'Drafts', icon: File },
  { in: 'outbox', label: 'Outbox', icon: Send },
] as const satisfies readonly { in: UnifiedView; label: string; icon: LucideIcon }[];

/**
 * The sidebar, lying directly on the desk: the unified views, then each account under its stamp,
 * with its folders. The current view lifts onto a pane. Collapsed to its rail, the unified views
 * keep only their icons, and the accounts wait for it to open.
 */
export const Sidebar = memo(function Sidebar({
  id,
  view,
  onSelect,
  accounts,
  folders,
  counts,
  isCollapsed,
  header,
  footer,
  onNewFolder,
  editing,
  onEdited,
  folderMenu,
  onEditAccount,
  onAddAccount,
  onMembers,
}: {
  id: string;
  view: View;
  onSelect: (view: View) => void;
  accounts: readonly Account[];
  folders: readonly Folder[];
  counts: ViewCounts;
  isCollapsed: boolean;
  /** What sits above the mailboxes, such as the search field on a desktop. */
  header?: ReactNode;
  footer: ReactNode;
  /** Asks for a new folder in an account, from the + beside its name. */
  onNewFolder: (account: Account) => void;
  /** A folder being named in place, new or renamed. */
  editing?: FolderEdit;
  /** Told the name to keep, or nothing to leave the folder as it was. */
  onEdited: (name: string | undefined) => void;
  /** What can be done to the folder in view, at the end of its row. */
  folderMenu?: ReactNode;
  /** Opens an account's page, from beside its name, where it is changed or removed. */
  onEditAccount?: (account: Account) => void;
  /** Starts adding an account, from the end of the accounts. */
  onAddAccount?: () => void;
  /** Opens the Members page, which only the operator has. */
  onMembers?: () => void;
}) {
  return (
    <nav id={id} aria-label="Mailboxes" {...stylex.props(styles.sidebar)}>
      {header && <div {...stylex.props(styles.header)}>{header}</div>}
      <div {...stylex.props(styles.scroll)}>
        <ul {...stylex.props(styles.rows)}>
          {UNIFIED_VIEWS.map(({ in: unified, label, icon }) => (
            <li key={unified}>
              <Row
                label={label}
                icon={icon}
                count={counts[unified]}
                isCountUnread={unified === 'inbox'}
                isSelected={view.in === unified}
                isCollapsed={isCollapsed}
                onSelect={() => onSelect({ in: unified })}
              />
            </li>
          ))}
        </ul>
        {!isCollapsed &&
          accounts.map((account) => (
            <section key={account.id} aria-label={account.name} {...stylex.props(styles.account)}>
              <div {...stylex.props(styles.accountHeader)}>
                <h2 {...stylex.props(styles.accountName)}>
                  <StampDot stamp={account.stamp} />
                  {account.name}
                </h2>
                <IconButton
                  label={`New folder in ${account.name}`}
                  tooltip={`New folder in ${account.name}`}
                  icon={<Icon icon={FolderPlus} size="sm" />}
                  variant="ghost"
                  size="sm"
                  onClick={() => onNewFolder(account)}
                />
                {onEditAccount && (
                  <IconButton
                    label={`Edit ${account.name}`}
                    tooltip={`Edit ${account.name}`}
                    icon={<Icon icon={Settings2} size="sm" />}
                    variant="ghost"
                    size="sm"
                    onClick={() => onEditAccount(account)}
                  />
                )}
              </div>
              <FolderRows
                nodes={folderTree(folders.filter((folder) => folder.account === account.id))}
                depth={0}
                view={view}
                onSelect={onSelect}
                editing={
                  editing?.do === 'create' && editing.account.id !== account.id
                    ? undefined
                    : editing
                }
                folders={folders.filter((folder) => folder.account === account.id)}
                onEdited={onEdited}
                folderMenu={folderMenu}
              />
            </section>
          ))}
        {!isCollapsed && onAddAccount && (
          <div {...stylex.props(styles.addAccount)}>
            <Button
              label="Add account"
              icon={<Icon icon={MailPlus} size="sm" />}
              variant="ghost"
              size="sm"
              onClick={onAddAccount}
            />
            {onMembers && (
              <Button
                label="Members"
                icon={<Icon icon={Users} size="sm" />}
                variant="ghost"
                size="sm"
                onClick={onMembers}
              />
            )}
          </div>
        )}
      </div>
      <div {...stylex.props(styles.footer, isCollapsed && styles.railFooter)}>{footer}</div>
    </nav>
  );
});

/**
 * An account's folders, each one followed by the folders inside it, a step further in. A folder
 * being renamed shows its name in a field, and a new one's field leads the folders it will join.
 */
function FolderRows({
  nodes,
  depth,
  view,
  onSelect,
  editing,
  folders,
  onEdited,
  folderMenu,
  parent,
}: {
  nodes: FolderNode[];
  depth: number;
  view: View;
  onSelect: (view: View) => void;
  editing: FolderEdit | undefined;
  /** The account's folders, whose names a new name can't take beside them. */
  folders: readonly Folder[];
  onEdited: (name: string | undefined) => void;
  folderMenu: ReactNode;
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
          label={`Name of the new folder in ${parent ? folderName(parent) : editing.account.name}`}
          depth={depth}
          place={{ folders, parent: parent?.path, delimiter: parent?.delimiter }}
          onDone={onEdited}
        />
      </Suspense>
    </li>
  );
  const row = ({ folder, children }: FolderNode) => {
    const isRenaming = editing?.do === 'rename' && editing.folder.path === folder.path;
    const isSelected = view.in === 'folder' && isFolder(view.folder, folder);
    const isParent = editing?.do === 'create' && editing.parent?.path === folder.path;
    const hasMenu = isSelected && folderMenu !== undefined;
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
          <span {...stylex.props(styles.folderLine)}>
            <Row
              label={folderName(folder)}
              hasMenu={hasMenu}
              depth={depth}
              count={folder.unread}
              isCountUnread={folder.role === 'inbox'}
              isSelected={isSelected}
              isCollapsed={false}
              onSelect={() =>
                onSelect({ in: 'folder', folder: { account: folder.account, path: folder.path } })
              }
            />
            {hasMenu && <span {...stylex.props(styles.folderMenu)}>{folderMenu}</span>}
          </span>
        )}
        {(children.length > 0 || isParent) && (
          <FolderRows
            nodes={children}
            depth={depth + 1}
            view={view}
            onSelect={onSelect}
            editing={editing}
            folders={folders}
            onEdited={onEdited}
            folderMenu={folderMenu}
            parent={folder}
          />
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

function Row({
  label,
  hasMenu = false,
  icon,
  depth = 0,
  count,
  isCountUnread,
  isSelected,
  isCollapsed,
  onSelect,
}: {
  label: string;
  /** Whether a menu sits over the row's end, which its count then makes room for. */
  hasMenu?: boolean;
  /** A folder has none, and lines its name up with the views' labels. */
  icon?: LucideIcon;
  /** How many folders a folder sits inside. */
  depth?: number;
  count: number | undefined;
  /** Unread mail in an Inbox counts in ink blue. Every other count is quiet. */
  isCountUnread: boolean;
  isSelected: boolean;
  isCollapsed: boolean;
  onSelect: () => void;
}) {
  const row = (
    <button
      type="button"
      aria-current={isSelected ? 'page' : undefined}
      aria-label={isCollapsed ? label : undefined}
      onClick={onSelect}
      {...stylex.props(
        styles.row,
        !icon && styles.folderRow(depth),
        isSelected && styles.selected,
        isCollapsed && styles.railRow,
        hasMenu && styles.roomForMenu,
      )}
    >
      {icon && <Icon icon={icon} size="sm" />}
      {!isCollapsed && <span {...stylex.props(styles.label)}>{label}</span>}
      {!isCollapsed && count ? (
        <span {...stylex.props(styles.count, isCountUnread && styles.countUnread)}>{count}</span>
      ) : null}
    </button>
  );
  return isCollapsed ? (
    <Tooltip content={label} placement="end">
      {row}
    </Tooltip>
  ) : (
    row
  );
}

const styles = stylex.create({
  sidebar: {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    overflow: 'hidden',
    paddingBlock: spacingVars['--spacing-1'],
    paddingTop: { default: null, [media.phone]: tm.safeTop },
    paddingBottom: { default: null, [media.phone]: tm.safeBottom },
    paddingInline: {
      default: spacingVars['--spacing-1'],
      [media.phone]: spacingVars['--spacing-2'],
    },
  },
  header: {
    flexShrink: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: spacingVars['--spacing-2'],
    padding: '1px',
    paddingBottom: spacingVars['--spacing-2'],
  },
  scroll: {
    flexGrow: 1,
    minHeight: 0,
    overflowY: 'auto',
    // Room for the selected row's lifted edge, which the scroll area would otherwise clip.
    padding: '1px',
  },
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
  // A folder's row, with the menu for the folder in view at its end, over the row's own end.
  folderLine: {
    position: 'relative',
    display: 'flex',
    alignItems: 'center',
  },
  folderMenu: {
    position: 'absolute',
    insetInlineEnd: spacingVars['--spacing-1'],
  },
  account: {
    marginTop: spacingVars['--spacing-3'],
  },
  addAccount: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: spacingVars['--spacing-1'],
    marginTop: spacingVars['--spacing-3'],
    paddingInline: spacingVars['--spacing-1'],
  },
  accountHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: spacingVars['--spacing-0-5'],
    paddingInlineEnd: spacingVars['--spacing-1'],
  },
  accountName: {
    display: 'flex',
    flexGrow: 1,
    alignItems: 'center',
    gap: spacingVars['--spacing-2'],
    marginBlock: 0,
    paddingInline: spacingVars['--spacing-2'],
    color: tm.textQuiet,
    fontSize: typeScaleVars['--text-supporting-size'],
    fontWeight: fontWeightVars['--font-weight-semibold'],
    lineHeight: typeScaleVars['--text-supporting-leading'],
    letterSpacing: '0.06em',
    textTransform: 'uppercase',
  },
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: spacingVars['--spacing-2'],
    width: '100%',
    minHeight: tm.target,
    paddingInline: spacingVars['--spacing-2'],
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
  // A folder's name starts where a view's label does, after the icon and its gap, and a step
  // further in for each folder it sits inside.
  folderRow: (depth: number) => ({
    paddingInlineStart: `calc(${spacingVars['--spacing-2']} * 2 + 1rem + ${depth} * ${spacingVars['--spacing-3']})`,
  }),
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
  roomForMenu: {
    paddingInlineEnd: `calc(${tm.target} + ${spacingVars['--spacing-1']})`,
  },
  railRow: {
    justifyContent: 'center',
    paddingInline: 0,
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
  // The footer's line takes the room, and its controls sit at the end.
  footer: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: spacingVars['--spacing-1'],
    paddingTop: spacingVars['--spacing-2'],
  },
  railFooter: {
    flexDirection: 'column',
    justifyContent: 'center',
  },
});
