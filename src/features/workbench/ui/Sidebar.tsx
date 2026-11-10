import { Icon } from '@astryxdesign/core/Icon';
import {
  colorVars,
  fontWeightVars,
  radiusVars,
  spacingVars,
  typeScaleVars,
} from '@astryxdesign/core/theme/tokens.stylex';
import { Tooltip } from '@astryxdesign/core/Tooltip';
import * as stylex from '@stylexjs/stylex';
import { File, Inbox, Send, Star, type LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { media, tm } from '../../../app/theme/tokens.stylex.ts';
import type { Account, Folder, FolderRole, View } from '../../mail/core/index.ts';
import { stampStyles } from '../../../app/theme/stamps.ts';

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

/** An account's folders in this order: the roles a person visits most, then their own, then bins. */
const ROLE_ORDER: Record<FolderRole, number> = {
  inbox: 0,
  archive: 1,
  sent: 2,
  drafts: 3,
  junk: 5,
  trash: 6,
};
const order = (folder: Folder) => (folder.role ? ROLE_ORDER[folder.role] : 4);

/**
 * The sidebar, lying directly on the desk: the unified views, then each account under its stamp,
 * with its folders. The current view lifts onto a pane. Collapsed to its rail, the unified views
 * keep only their icons, and the accounts wait for it to open.
 */
export function Sidebar({
  id,
  view,
  onSelect,
  accounts,
  folders,
  counts,
  isCollapsed,
  footer,
}: {
  id: string;
  view: View;
  onSelect: (view: View) => void;
  accounts: readonly Account[];
  folders: readonly Folder[];
  counts: ViewCounts;
  isCollapsed: boolean;
  footer: ReactNode;
}) {
  return (
    <nav id={id} aria-label="Mailboxes" {...stylex.props(styles.sidebar)}>
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
              <h2 {...stylex.props(styles.accountName)}>
                <span {...stylex.props(styles.stamp, stampStyles[account.stamp])} />
                {account.name}
              </h2>
              <ul {...stylex.props(styles.rows)}>
                {folders
                  .filter((folder) => folder.account === account.id)
                  .toSorted((a, b) => order(a) - order(b) || a.name.localeCompare(b.name))
                  .map((folder) => (
                    <li key={folder.path}>
                      <Row
                        label={folder.name}
                        count={folder.unread}
                        isCountUnread={folder.role === 'inbox'}
                        isSelected={
                          view.in === 'folder' &&
                          view.folder.account === folder.account &&
                          view.folder.path === folder.path
                        }
                        isCollapsed={false}
                        onSelect={() =>
                          onSelect({
                            in: 'folder',
                            folder: { account: account.id, path: folder.path },
                          })
                        }
                      />
                    </li>
                  ))}
              </ul>
            </section>
          ))}
      </div>
      <div {...stylex.props(styles.footer, isCollapsed && styles.railFooter)}>{footer}</div>
    </nav>
  );
}

function Row({
  label,
  icon,
  count,
  isCountUnread,
  isSelected,
  isCollapsed,
  onSelect,
}: {
  label: string;
  /** A folder has none, and lines its name up with the views' labels. */
  icon?: LucideIcon;
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
        !icon && styles.folderRow,
        isSelected && styles.selected,
        isCollapsed && styles.railRow,
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
  account: {
    marginTop: spacingVars['--spacing-3'],
  },
  accountName: {
    display: 'flex',
    alignItems: 'center',
    gap: spacingVars['--spacing-2'],
    marginBlock: 0,
    marginBottom: spacingVars['--spacing-0-5'],
    paddingInline: spacingVars['--spacing-2'],
    color: tm.textQuiet,
    fontSize: typeScaleVars['--text-supporting-size'],
    fontWeight: fontWeightVars['--font-weight-semibold'],
    lineHeight: typeScaleVars['--text-supporting-leading'],
    letterSpacing: '0.06em',
    textTransform: 'uppercase',
  },
  stamp: {
    flexShrink: 0,
    width: '8px',
    height: '8px',
    borderRadius: '3px',
    forcedColorAdjust: 'none',
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
  // A folder's name starts where a view's label does, after the icon and its gap.
  folderRow: {
    paddingInlineStart: `calc(${spacingVars['--spacing-2']} * 2 + 1rem)`,
  },
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
  footer: {
    display: 'flex',
    paddingTop: spacingVars['--spacing-2'],
  },
  railFooter: {
    justifyContent: 'center',
  },
});
