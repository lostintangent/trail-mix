import { Icon } from '@astryxdesign/core/Icon';
import {
  colorVars,
  focusVars,
  radiusVars,
  spacingVars,
} from '@astryxdesign/core/theme/tokens.stylex';
import * as stylex from '@stylexjs/stylex';
import { MailPlus } from 'lucide-react';
import { useRef, type ReactNode } from 'react';
import { LaterTooltip } from '../../../shared/LaterTooltip.tsx';
import { StampDot } from '../../../app/theme/StampDot.tsx';
import { media, tm } from '../../../app/theme/tokens.stylex.ts';
import type { Account, Folder, View } from '../../mail/core/index.ts';
import { lift, troubleOf } from './Tree.tsx';
import { UNIFIED_VIEWS, type ViewCounts } from './views.ts';

/**
 * The folded sidebar, one target wide: under the fold button and a rule, the views and each
 * account's stamp, then Add account and New message over a rule and the gear, so folding gives up
 * the tree without taking anything the member needs. Each shows its name as a tooltip, a stamp
 * opens its account's Inbox, and an account that needs the member marks its stamp. The fold button
 * and the gear are the sidebar's, pinned over both layouts.
 */
export function RailContent({
  compose,
  view,
  onSelect,
  accounts,
  folders,
  counts,
  onAddAccount,
}: {
  compose?: ReactNode;
  view: View;
  onSelect: (view: View) => void;
  accounts: readonly Account[];
  folders: readonly Folder[];
  counts: ViewCounts;
  onAddAccount?: () => void;
}) {
  return (
    <>
      {/* Where the pinned fold button lands. */}
      <span {...stylex.props(styles.foldRoom)} />
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
          const trouble = troubleOf(account);
          return (
            <RailButton
              key={account.id}
              label={[account.name, trouble, inbox?.unread && `${inbox.unread} unread`]
                .filter(Boolean)
                .join(', ')}
              isSelected={view.in === 'folder' && view.folder.account === account.id}
              hasDot={Boolean(inbox?.unread)}
              isTroubled={trouble !== undefined}
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
      {compose}
      <span {...stylex.props(styles.rule)} />
      {/* Where the pinned gear lands. */}
      <span {...stylex.props(styles.foldRoom)} />
    </>
  );
}

function RailButton({
  label,
  isSelected = false,
  hasDot = false,
  isTroubled = false,
  onSelect,
  children,
}: {
  label: string;
  isSelected?: boolean;
  /** Marks unread mail in Inbox in the accent, whose count is in the label. */
  hasDot?: boolean;
  /** Marks an account that needs the member, in the error's color, as its label says. */
  isTroubled?: boolean;
  onSelect: () => void;
  children: ReactNode;
}) {
  const button = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button
        ref={button}
        type="button"
        aria-label={label}
        aria-current={isSelected ? 'page' : undefined}
        onClick={onSelect}
        {...stylex.props(styles.railButton, isSelected && lift.selected)}
      >
        {children}
        {hasDot && <span {...stylex.props(styles.dot)} />}
        {isTroubled && <span {...stylex.props(styles.troubled)} />}
      </button>
      <LaterTooltip anchor={button} content={label} placement="end" />
    </>
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
  // An account that needs the member: a ringed dot of the error's color at the stamp's lower corner,
  // apart from the unread dot above it.
  troubled: {
    position: 'absolute',
    bottom: spacingVars['--spacing-1'],
    insetInlineEnd: spacingVars['--spacing-1'],
    width: spacingVars['--spacing-2'],
    height: spacingVars['--spacing-2'],
    borderRadius: '50%',
    backgroundColor: { default: colorVars['--color-error'], [media.forcedColors]: 'Mark' },
    boxShadow: `0 0 0 2px ${colorVars['--color-background-body']}`,
    forcedColorAdjust: 'none',
  },
  // The rail's separators: the header's line, turned on its side.
  rule: {
    flexShrink: 0,
    width: '1rem',
    height: '1px',
    marginBlock: spacingVars['--spacing-1-5'],
    backgroundColor: tm.rule,
  },
});
