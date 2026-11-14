import { Button } from '@astryxdesign/core/Button';
import { Icon } from '@astryxdesign/core/Icon';
import {
  colorVars,
  durationVars,
  fontWeightVars,
  spacingVars,
  typeScaleVars,
} from '@astryxdesign/core/theme/tokens.stylex';
import * as stylex from '@stylexjs/stylex';
import { MailPlus } from 'lucide-react';
import { memo, useEffect, useState, type ReactNode } from 'react';
import { media, tm } from '../../../app/theme/tokens.stylex.ts';
import type { Command } from '../../commands/index.ts';
import type { Account, Folder, View } from '../../mail/core/index.ts';
import type { FolderEdit } from './commands.ts';
import { useFolds } from './folds.ts';
import { RailContent } from './SidebarRail.tsx';
import { AccountSection, ViewRows } from './Tree.tsx';
import { onTreeKey, preloadTreeMoves } from './treeKeys.ts';
import type { ViewCounts } from './views.ts';

/** The name at the foot of the sidebar. */
const NAME = 'Trail Mix';

/**
 * The sidebar, lying directly on the desk: on a desktop, the fold button and the search at its
 * head, then the unified views, then each account under its stamp, with its folders, and at its
 * foot the Settings gear, a short rule, Trail Mix's name and, at the far end, New message. The
 * current view lifts onto a pane.
 *
 * On a desktop it has two layouts over one origin, as Toy Box's and GistPad's do: the whole tree,
 * and the rail it folds to, which keeps the views, each account's stamp and New message in reach.
 * They crossfade rather than swap, and the fold button at the top and the gear at the foot are
 * pinned outside both, so they hold still while the content around them leaves and arrives. New
 * message is pinned after the gear, so a Tab reaches the foot from left to right.
 */
export const Sidebar = memo(function Sidebar({
  id,
  view,
  onSelect,
  accounts,
  folders,
  counts,
  fold,
  isCollapsed,
  expandedWidth,
  search,
  settings,
  compose,
  note,
  isBusy = false,
  editing,
  onEdited,
  folderActions,
  accountActions,
  onAddAccount,
}: {
  id: string;
  view: View;
  onSelect: (view: View) => void;
  accounts: readonly Account[];
  folders: readonly Folder[];
  counts: ViewCounts;
  /**
   * The button that folds the sidebar to its rail and back, which holds still across the fold.
   * Only a desktop's sidebar folds, so a phone's has none.
   */
  fold?: ReactNode;
  /** Whether it shows its rail. */
  isCollapsed: boolean;
  /**
   * The width the whole tree keeps, in pixels, while the sidebar narrows to its rail or widens
   * from it, so the sidebar clips it rather than squeezing it. Nothing while it tracks a drag.
   */
  expandedWidth?: number;
  /** What heads the sidebar beside the fold button, such as the search field on a desktop. */
  search?: ReactNode;
  /** The Settings gear, at the foot, pinned there over both layouts where the sidebar folds. */
  settings: ReactNode;
  /**
   * New message, at the far end of the foot, and on the rail just above the gear. A phone's
   * sidebar has none, since its bar has Write.
   */
  compose?: ReactNode;
  /** A quiet line above the foot, such as the public demo's naming itself. */
  note?: string;
  /**
   * Whether what the tree shows is still on its way, as while the Mailroom checks the accounts,
   * which it says only to assistive technology, as `aria-busy`.
   */
  isBusy?: boolean;
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
}) {
  const [folds, toggleFold] = useFolds();
  const canFold = fold !== undefined;
  const isRail = canFold && isCollapsed;
  const { isDrawn: isRailDrawn, isShown: isRailShown } = useRail(isRail);
  // Whether a line of the tree lifts for the view, which a search's or a folder's on its way doesn't.
  const isViewHere =
    view.in === 'folder'
      ? folders.some(
          ({ account, path }) => account === view.folder.account && path === view.folder.path,
        )
      : view.in !== 'search';
  return (
    <nav id={id} aria-label="Mailboxes" aria-busy={isBusy} {...stylex.props(styles.sidebar)}>
      {/* First, as it reads: it heads both layouts. */}
      {canFold && <div {...stylex.props(styles.pinned)}>{fold}</div>}
      <div
        aria-hidden={isRail || undefined}
        inert={isRail}
        {...stylex.props(
          styles.layer,
          styles.expanded,
          expandedWidth !== undefined && styles.width(`${expandedWidth}px`),
          canFold && (isRail ? styles.leaving : styles.arriving),
        )}
      >
        {(canFold || search) && (
          <div {...stylex.props(styles.header)}>
            {/* Where the pinned fold button lands. */}
            {canFold && <span {...stylex.props(styles.foldRoom)} />}
            {search && <div {...stylex.props(styles.search)}>{search}</div>}
          </div>
        )}
        <div onKeyDown={onTreeKey} onFocus={preloadTreeMoves} {...stylex.props(styles.scroll)}>
          <ViewRows view={view} isViewHere={isViewHere} counts={counts} onSelect={onSelect} />
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
            </div>
          )}
        </div>
        {note && <p {...stylex.props(styles.note)}>{note}</p>}
        <div {...stylex.props(styles.footer)}>
          {/* Where the pinned gear lands, or the gear itself where the sidebar never folds. */}
          {canFold ? <span {...stylex.props(styles.footRoom)} /> : settings}
          <span aria-hidden {...stylex.props(styles.footRule)} />
          <span {...stylex.props(styles.name)}>{NAME}</span>
          {/* Where the pinned New message lands. */}
          {compose && (canFold ? <span {...stylex.props(styles.footRoom)} /> : compose)}
        </div>
      </div>
      {canFold && (
        <>
          {isRailDrawn && (
            <div
              aria-hidden={!isRailShown || undefined}
              inert={!isRailShown}
              {...stylex.props(
                styles.layer,
                styles.rail,
                isRailShown ? styles.arriving : styles.leaving,
              )}
            >
              <RailContent
                compose={compose}
                view={view}
                onSelect={onSelect}
                accounts={accounts}
                folders={folders}
                counts={counts}
                onAddAccount={onAddAccount}
              />
            </div>
          )}
          {/* Last, as it reads: it ends both layouts. */}
          <div {...stylex.props(styles.pinnedFoot)}>{settings}</div>
          {compose && (
            <div
              aria-hidden={isRail || undefined}
              inert={isRail}
              {...stylex.props(
                styles.pinnedCompose,
                expandedWidth !== undefined && styles.width(`${expandedWidth}px`),
                isRail ? styles.leaving : styles.arriving,
              )}
            >
              <span {...stylex.props(styles.pinnedControl)}>{compose}</span>
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
  // Its lines start the sidebar's inset in, after the pixel of room their header and tree keep.
  expanded: {
    width: '100%',
    paddingInline: `calc(${tm.sidebarInset} - 1px)`,
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
    width: tm.sidebarRail,
  },
  foldRoom: {
    flexShrink: 0,
    width: tm.target,
    height: tm.target,
  },
  // The gear, over both layouts, centered on the rail and level with the footer's line.
  pinnedFoot: {
    position: 'absolute',
    bottom: spacingVars['--spacing-2'],
    insetInlineStart: 0,
    zIndex: 1,
    display: 'flex',
    justifyContent: 'center',
    width: tm.sidebarRail,
  },
  // New message, at the far end of the footer's line, as wide as the whole tree so it holds still
  // as the sidebar narrows, and fading with the tree. Only the button itself takes the pointer.
  pinnedCompose: {
    position: 'absolute',
    bottom: spacingVars['--spacing-2'],
    insetInlineStart: 0,
    zIndex: 1,
    display: 'flex',
    justifyContent: 'flex-end',
    width: '100%',
    paddingInlineEnd: tm.sidebarInset,
    pointerEvents: 'none',
    transitionProperty: 'opacity',
    transitionTimingFunction: 'ease-out',
  },
  pinnedControl: {
    display: 'flex',
    pointerEvents: 'auto',
  },
  header: {
    flexShrink: 0,
    display: 'flex',
    alignItems: 'center',
    gap: spacingVars['--spacing-1'],
    padding: '1px',
  },
  search: {
    flexGrow: 1,
    minWidth: 0,
  },
  // The tree scrolls between the header and the footer, and fades out at either edge, as Toy Box's
  // does, so a row passing under one is never seen cut. At rest, the first and last rows sit clear
  // of the fades. The padding's pixel is room for a selected row's lifted edge.
  scroll: {
    flexGrow: 1,
    minHeight: 0,
    overflowY: 'auto',
    scrollbarWidth: 'thin',
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
  // A rule across the sidebar sets the footer off from the tree above it, as in Toy Box. Its gear
  // starts where the header's fold button does, the inset in, so the pinned one lines up with both.
  footer: {
    display: 'flex',
    alignItems: 'center',
    gap: spacingVars['--spacing-2'],
    marginInline: `calc(1px - ${tm.sidebarInset})`,
    paddingTop: spacingVars['--spacing-2'],
    paddingInline: tm.sidebarInset,
    borderTopWidth: '1px',
    borderTopStyle: 'solid',
    borderTopColor: colorVars['--color-border'],
  },
  footRoom: {
    flexShrink: 0,
    width: tm.target,
    height: tm.target,
  },
  // The short upright rule between the gear and the name, the rail's rules stood on end. The gear's
  // target pads its icon, so the rule sits a little further from the name to look centered.
  footRule: {
    flexShrink: 0,
    width: '1px',
    height: '1rem',
    marginInlineEnd: spacingVars['--spacing-1'],
    backgroundColor: tm.rule,
  },
  name: {
    flexGrow: 1,
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    color: colorVars['--color-text-primary'],
    fontWeight: fontWeightVars['--font-weight-semibold'],
  },
  // Quiet, and wrapping rather than cut, since it says what this Trail Mix is. Clear of the tree's
  // lines above, which scroll under its edge.
  note: {
    margin: 0,
    paddingInline: spacingVars['--spacing-2'],
    paddingBlock: spacingVars['--spacing-2'],
    color: tm.textQuiet,
    fontSize: typeScaleVars['--text-supporting-size'],
  },
  // It holds its own width rather than the sidebar's, so its icons sit where they'll stay from the
  // first frame of a fold, rather than sliding in as the sidebar narrows.
  rail: {
    width: tm.sidebarRail,
    alignItems: 'center',
    gap: spacingVars['--spacing-0-5'],
  },
});
