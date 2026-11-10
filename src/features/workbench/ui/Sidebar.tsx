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

/** The views that gather mail across every account. */
export const VIEWS = [
  { id: 'inbox', label: 'Inbox', icon: Inbox },
  { id: 'flagged', label: 'Flagged', icon: Star },
  { id: 'drafts', label: 'Drafts', icon: File },
  { id: 'outbox', label: 'Outbox', icon: Send },
] as const satisfies readonly { id: string; label: string; icon: LucideIcon }[];

export type UnifiedView = (typeof VIEWS)[number]['id'];

/**
 * The sidebar, lying directly on the desk: the unified views, then each account's folders. The
 * current view lifts onto a pane. Collapsed to its rail, each view keeps only its icon.
 */
export function Sidebar({
  id,
  view,
  onSelect,
  isCollapsed,
  footer,
}: {
  id: string;
  view: UnifiedView;
  onSelect: (view: UnifiedView) => void;
  isCollapsed: boolean;
  footer: ReactNode;
}) {
  return (
    <nav id={id} aria-label="Mailboxes" {...stylex.props(styles.sidebar)}>
      <ul {...stylex.props(styles.views)}>
        {VIEWS.map(({ id: viewId, label, icon }) => (
          <li key={viewId}>
            <ViewRow
              label={label}
              icon={icon}
              isSelected={viewId === view}
              isCollapsed={isCollapsed}
              onSelect={() => onSelect(viewId)}
            />
          </li>
        ))}
      </ul>
      {!isCollapsed && <div {...stylex.props(styles.footer)}>{footer}</div>}
    </nav>
  );
}

function ViewRow({
  label,
  icon,
  isSelected,
  isCollapsed,
  onSelect,
}: {
  label: string;
  icon: LucideIcon;
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
      {...stylex.props(styles.row, isSelected && styles.selected, isCollapsed && styles.railRow)}
    >
      <Icon icon={icon} size="sm" />
      {!isCollapsed && <span {...stylex.props(styles.label)}>{label}</span>}
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
  views: {
    display: 'flex',
    flexDirection: 'column',
    gap: spacingVars['--spacing-0-5'],
    margin: 0,
    padding: 0,
    listStyle: 'none',
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
  footer: {
    marginTop: 'auto',
    paddingTop: spacingVars['--spacing-2'],
  },
});
