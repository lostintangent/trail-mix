import { Button } from '@astryxdesign/core/Button';
import { Icon } from '@astryxdesign/core/Icon';
import { colorVars, durationVars, spacingVars } from '@astryxdesign/core/theme/tokens.stylex';
import * as stylex from '@stylexjs/stylex';
import { MailPlus, Users } from 'lucide-react';
import { memo, useEffect, useState, type ReactNode } from 'react';
import { media, tm } from '../../../app/theme/tokens.stylex.ts';
import type { Command } from '../../commands/index.ts';
import type { Account, Folder, View } from '../../mail/core/index.ts';
import type { FolderEdit } from './commands.ts';
import { useFolds } from './folds.ts';
import { RailContent } from './SidebarRail.tsx';
import { AccountSection, ViewRows } from './Tree.tsx';
import type { ViewCounts } from './views.ts';

/** What a desktop's sidebar needs to fold to its rail. A phone's never folds. */
export type SidebarRail = {
  /** The rail's width, in pixels. */
  width: number;
  /** The button that folds and unfolds the sidebar, which holds still across the fold. */
  fold: ReactNode;
  /** What leads the rail, such as New message. */
  top: ReactNode;
};

/** Where the footer sits: along the sidebar's foot, or stacked at the rail's. */
export type FooterPlace = 'sidebar' | 'rail';

/**
 * The sidebar, lying directly on the desk: the unified views, then each account under its stamp,
 * with its folders. The current view lifts onto a pane.
 *
 * On a desktop it has two layouts over one origin, as Toy Box's and GistPad's do: the whole tree,
 * and the rail it folds to, which keeps the views, each account's stamp and the footer's actions
 * in reach. They crossfade rather than swap, and the fold button is pinned outside both, so it
 * holds still while the content around it leaves and arrives.
 */
export const Sidebar = memo(function Sidebar({
  id,
  view,
  onSelect,
  accounts,
  folders,
  counts,
  rail,
  isCollapsed,
  expandedWidth,
  header,
  search,
  footer,
  editing,
  onEdited,
  folderActions,
  accountActions,
  onAddAccount,
  onMembers,
}: {
  id: string;
  view: View;
  onSelect: (view: View) => void;
  accounts: readonly Account[];
  folders: readonly Folder[];
  counts: ViewCounts;
  /** How the sidebar folds, which only a desktop's does. */
  rail?: SidebarRail;
  /** Whether it shows its rail. */
  isCollapsed: boolean;
  /**
   * The width the whole tree keeps, in pixels, while the sidebar narrows to its rail or widens
   * from it, so the sidebar clips it rather than squeezing it. Nothing while it tracks a drag.
   */
  expandedWidth?: number;
  /** What leads the sidebar beside the fold button, such as New message on a desktop. */
  header?: ReactNode;
  /** What sits under the header, such as the search field on a desktop. */
  search?: ReactNode;
  footer: (place: FooterPlace) => ReactNode;
  /** A folder being named in place, new or renamed. */
  editing?: FolderEdit;
  /** Told the name to keep, or nothing to leave the folder as it was. */
  onEdited: (name: string | undefined) => void;
  /** What can be done to a folder, for the menu on its row. Asked only as the menu opens. */
  folderActions: (folder: Folder) => readonly Command[];
  /** What can be done to an account, for the menu beside its name. */
  accountActions: (account: Account) => readonly Command[];
  /** Starts adding an account, from the end of the accounts. */
  onAddAccount?: () => void;
  /** Opens the Members page, which only the operator has. */
  onMembers?: () => void;
}) {
  const [folds, toggleFold] = useFolds();
  const isRail = rail !== undefined && isCollapsed;
  const { isDrawn: isRailDrawn, isShown: isRailShown } = useRail(isRail);
  return (
    <nav id={id} aria-label="Mailboxes" {...stylex.props(styles.sidebar)}>
      {/* First, as it reads: it heads both layouts. */}
      {rail && (
        <div {...stylex.props(styles.pinned, styles.width(`${rail.width}px`))}>{rail.fold}</div>
      )}
      <div
        aria-hidden={isRail || undefined}
        inert={isRail}
        {...stylex.props(
          styles.layer,
          styles.expanded,
          expandedWidth !== undefined && styles.width(`${expandedWidth}px`),
          rail && (isRail ? styles.leaving : styles.arriving),
        )}
      >
        {(header || search) && (
          <div {...stylex.props(styles.header)}>
            {header && (
              <div {...stylex.props(styles.headerLine)}>
                {/* Where the pinned fold button lands. */}
                {rail && <span {...stylex.props(styles.foldRoom)} />}
                {header}
              </div>
            )}
            {search}
          </div>
        )}
        <div {...stylex.props(styles.scroll)}>
          <ViewRows view={view} counts={counts} onSelect={onSelect} />
          {accounts.map((account) => (
            <AccountSection
              key={account.id}
              account={account}
              folders={folders}
              view={view}
              onSelect={onSelect}
              folds={folds}
              onFold={toggleFold}
              editing={editing}
              onEdited={onEdited}
              folderActions={folderActions}
              accountActions={accountActions}
            />
          ))}
          {onAddAccount && (
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
        <div {...stylex.props(styles.footer)}>{footer('sidebar')}</div>
      </div>
      {rail && (
        <>
          {isRailDrawn && (
            <div
              aria-hidden={!isRailShown || undefined}
              inert={!isRailShown}
              // The rail holds its own width rather than the sidebar's, so its icons sit where they'll
              // stay from the first frame of a fold, rather than sliding in as the sidebar narrows.
              {...stylex.props(
                styles.layer,
                styles.rail,
                styles.width(`${rail.width}px`),
                isRailShown ? styles.arriving : styles.leaving,
              )}
            >
              <RailContent
                rail={rail}
                view={view}
                onSelect={onSelect}
                accounts={accounts}
                folders={folders}
                counts={counts}
                footer={footer}
                onAddAccount={onAddAccount}
                onMembers={onMembers}
              />
            </div>
          )}
        </>
      )}
    </nav>
  );
});

/**
 * Whether the rail is drawn, and whether it shows. It's first drawn as the sidebar first folds,
 * hidden for a frame so that it fades in, and kept after that. A sidebar that never folds never
 * draws it.
 */
function useRail(isRail: boolean): { isDrawn: boolean; isShown: boolean } {
  const [isDrawn, setDrawn] = useState(isRail);
  const [hasFrame, setHasFrame] = useState(isRail);
  if (isRail && !isDrawn) setDrawn(true);
  useEffect(() => {
    if (!isDrawn || hasFrame) return;
    const frame = requestAnimationFrame(() => setHasFrame(true));
    return () => cancelAnimationFrame(frame);
  }, [isDrawn, hasFrame]);
  return { isDrawn, isShown: isRail && hasFrame };
}

const styles = stylex.create({
  sidebar: {
    position: 'relative',
    height: '100%',
    overflow: 'clip',
  },
  // The two layouts lie over one origin, and the one leaving clears out quickly while the one
  // arriving waits for the width to settle, so neither is ever seen squeezed. The arriving one
  // lands as the panes finish moving.
  layer: {
    position: 'absolute',
    insetBlock: 0,
    insetInlineStart: 0,
    display: 'flex',
    flexDirection: 'column',
    paddingBlock: spacingVars['--spacing-2'],
    paddingTop: { default: null, [media.phone]: tm.safeTop },
    paddingBottom: { default: null, [media.phone]: tm.safeBottom },
    transitionProperty: 'opacity',
    transitionTimingFunction: 'ease-out',
  },
  expanded: {
    width: '100%',
    paddingInline: spacingVars['--spacing-2'],
  },
  width: (width: string) => ({ width }),
  arriving: {
    opacity: 1,
    transitionDelay: {
      default: `calc(${durationVars['--duration-medium']} - ${durationVars['--duration-fast']})`,
      [media.reducedMotion]: '0s',
    },
    transitionDuration: { default: durationVars['--duration-fast'], [media.reducedMotion]: '0s' },
  },
  leaving: {
    opacity: 0,
    pointerEvents: 'none',
    transitionDuration: { default: durationVars['--duration-fast'], [media.reducedMotion]: '0s' },
  },
  // The fold button, over both layouts, centered on the rail and level with the header's line.
  pinned: {
    position: 'absolute',
    top: `calc(${spacingVars['--spacing-2']} + 1px)`,
    insetInlineStart: 0,
    zIndex: 1,
    display: 'flex',
    justifyContent: 'center',
  },
  foldRoom: {
    flexShrink: 0,
    width: tm.target,
    height: tm.target,
  },
  header: {
    flexShrink: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: spacingVars['--spacing-2'],
    padding: '1px',
  },
  headerLine: {
    display: 'flex',
    alignItems: 'center',
    gap: spacingVars['--spacing-1'],
  },
  // The tree scrolls between the header and the footer, and fades out at either edge, as Toy Box's
  // does, so a row passing under one is never seen cut. At rest, the first and last rows sit clear
  // of the fades. The padding's pixel is room for a selected row's lifted edge.
  scroll: {
    flexGrow: 1,
    minHeight: 0,
    overflowY: 'auto',
    padding: '1px',
    paddingTop: `calc(${spacingVars['--spacing-2']} + 1px)`,
    paddingBottom: `calc(${spacingVars['--spacing-4']} + 1px)`,
    maskImage: `linear-gradient(transparent, #000 ${spacingVars['--spacing-2']}, #000 calc(100% - ${spacingVars['--spacing-4']}), transparent)`,
  },
  addAccount: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: spacingVars['--spacing-1'],
    marginTop: spacingVars['--spacing-3'],
    paddingInline: spacingVars['--spacing-1'],
  },
  // The footer's line takes the room, and its controls sit at the end.
  // A rule across the sidebar sets the footer off from the tree above it, as in Toy Box.
  footer: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: spacingVars['--spacing-1'],
    marginInline: `calc(-1 * ${spacingVars['--spacing-2']})`,
    paddingTop: spacingVars['--spacing-2'],
    paddingInline: spacingVars['--spacing-2'],
    borderTopWidth: '1px',
    borderTopStyle: 'solid',
    borderTopColor: colorVars['--color-border'],
  },
  rail: {
    alignItems: 'center',
    gap: spacingVars['--spacing-0-5'],
  },
});
