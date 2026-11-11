import { Icon } from '@astryxdesign/core/Icon';
import {
  colorVars,
  focusVars,
  radiusVars,
  spacingVars,
} from '@astryxdesign/core/theme/tokens.stylex';
import { Tooltip } from '@astryxdesign/core/Tooltip';
import * as stylex from '@stylexjs/stylex';
import { MailPlus, Users } from 'lucide-react';
import type { ReactNode } from 'react';
import { StampDot } from '../../../app/theme/StampDot.tsx';
import { tm } from '../../../app/theme/tokens.stylex.ts';
import type { Account, Folder, View } from '../../mail/core/index.ts';
import type { FooterPlace, SidebarRail } from './Sidebar.tsx';
import { lift } from './Tree.tsx';
import { UNIFIED_VIEWS, type ViewCounts } from './views.ts';

/**
 * The folded sidebar: its header and footer turned on their side, one target wide, with the views
 * and each account's stamp between them, so folding gives up the tree without taking anything the
 * member needs. Each shows its name as a tooltip, and a stamp opens its account's Inbox.
 */
export function RailContent({
  rail,
  view,
  onSelect,
  accounts,
  folders,
  counts,
  footer,
  onAddAccount,
  onMembers,
}: {
  rail: SidebarRail;
  view: View;
  onSelect: (view: View) => void;
  accounts: readonly Account[];
  folders: readonly Folder[];
  counts: ViewCounts;
  footer: (place: FooterPlace) => ReactNode;
  onAddAccount?: () => void;
  onMembers?: () => void;
}) {
  return (
    <>
      <span {...stylex.props(styles.foldRoom)} />
      {rail.top}
      <span {...stylex.props(styles.rule)} />
      <div {...stylex.props(styles.railScroll)}>
        {UNIFIED_VIEWS.map(({ in: unified, label, icon }) => {
          const unread = unified === 'inbox' ? counts.inbox : undefined;
          return (
            <RailButton
              key={unified}
              label={unread ? `${label}, ${unread} unread` : label}
              isSelected={view.in === unified}
              hasDot={Boolean(unread)}
              onSelect={() => onSelect({ in: unified })}
            >
              <Icon icon={icon} size="sm" />
            </RailButton>
          );
        })}
        {accounts.length > 0 && <span {...stylex.props(styles.rule)} />}
        {accounts.map((account) => {
          const inbox =
            folders.find((folder) => folder.account === account.id && folder.role === 'inbox') ??
            folders.find((folder) => folder.account === account.id);
          return (
            <RailButton
              key={account.id}
              label={inbox?.unread ? `${account.name}, ${inbox.unread} unread` : account.name}
              isSelected={view.in === 'folder' && view.folder.account === account.id}
              hasDot={Boolean(inbox?.unread)}
              onSelect={() =>
                inbox &&
                onSelect({ in: 'folder', folder: { account: inbox.account, path: inbox.path } })
              }
            >
              <StampDot stamp={account.stamp} isLarge />
            </RailButton>
          );
        })}
      </div>
      {onAddAccount && (
        <RailButton label="Add account" onSelect={onAddAccount}>
          <Icon icon={MailPlus} size="sm" />
        </RailButton>
      )}
      {onMembers && (
        <RailButton label="Members" onSelect={onMembers}>
          <Icon icon={Users} size="sm" />
        </RailButton>
      )}
      <span {...stylex.props(styles.rule)} />
      <div {...stylex.props(styles.railFooter)}>{footer('rail')}</div>
    </>
  );
}

function RailButton({
  label,
  isSelected = false,
  hasDot = false,
  onSelect,
  children,
}: {
  label: string;
  isSelected?: boolean;
  /** Marks unread mail in Inbox in the accent, whose count is in the label. */
  hasDot?: boolean;
  onSelect: () => void;
  children: ReactNode;
}) {
  return (
    <Tooltip content={label} placement="end">
      <button
        type="button"
        aria-label={label}
        aria-current={isSelected ? 'page' : undefined}
        onClick={onSelect}
        {...stylex.props(styles.railButton, isSelected && lift.selected)}
      >
        {children}
        {hasDot && <span {...stylex.props(styles.dot)} />}
      </button>
    </Tooltip>
  );
}

const styles = stylex.create({
  foldRoom: {
    flexShrink: 0,
    width: tm.target,
    height: tm.target,
  },
  railScroll: {
    flexGrow: 1,
    minHeight: 0,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: spacingVars['--spacing-0-5'],
    width: '100%',
    overflowY: 'auto',
    scrollbarWidth: 'none',
    padding: '1px',
  },
  railButton: {
    position: 'relative',
    display: 'grid',
    placeItems: 'center',
    flexShrink: 0,
    width: tm.target,
    height: tm.target,
    padding: 0,
    borderWidth: 0,
    borderRadius: radiusVars['--radius-element'],
    backgroundColor: {
      default: 'transparent',
      ':hover': { default: null, '@media (hover: hover)': colorVars['--color-overlay-hover'] },
    },
    color: colorVars['--color-text-secondary'],
    cursor: 'pointer',
    outline: {
      default: null,
      // The focus ring every Astryx control draws.
      ':focus-visible': `${focusVars['--focus-outline-width']} ${focusVars['--focus-outline-style']} ${focusVars['--focus-outline-color']}`,
    },
    outlineOffset: '-2px',
  },
  // Unread mail waits behind it: a dot of the accent at the icon's corner.
  dot: {
    position: 'absolute',
    top: spacingVars['--spacing-1'],
    insetInlineEnd: spacingVars['--spacing-1'],
    width: spacingVars['--spacing-1-5'],
    height: spacingVars['--spacing-1-5'],
    borderRadius: '50%',
    backgroundColor: colorVars['--color-accent'],
    forcedColorAdjust: 'none',
  },
  // The rail's separators: the footer's line, turned on its side.
  rule: {
    flexShrink: 0,
    width: '1rem',
    height: '1px',
    marginBlock: spacingVars['--spacing-1-5'],
    backgroundColor: colorVars['--color-border'],
  },
  railFooter: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: spacingVars['--spacing-0-5'],
  },
});
