import { colorVars, durationVars } from '@astryxdesign/core/theme/tokens.stylex';
import * as stylex from '@stylexjs/stylex';
import { useId, useMemo, useState, type ReactNode } from 'react';
import { media, tm } from '../../../app/theme/tokens.stylex.ts';
import type {
  Account,
  ConversationId,
  ConversationSummary,
  Folder,
  View,
} from '../../mail/core/index.ts';
import { ListPane } from './ListPane.tsx';
import { PanelEdge } from './PanelEdge.tsx';
import { PANELS } from './panels.ts';
import { ReaderPane } from './ReaderPane.tsx';
import { StatusLine } from './StatusLine.tsx';
import { folderName, Sidebar, UNIFIED_VIEWS, type ViewCounts } from '../../folders/index.ts';
import { useMediaQuery } from './useMediaQuery.ts';
import { usePanel } from './usePanel.ts';

type Pane = 'sidebar' | 'list' | 'reader';

/** The desktop columns: each side panel at the size on its custom property, then the reader. */
const COLUMNS = `var(${PANELS.sidebar.variable}) var(${PANELS.list.variable}) minmax(0, 1fr)`;

/**
 * The desk and what lies on it: the sidebar directly on the desk, then the list and reader sheets.
 * On a desktop the sidebar and the list are side panels, resized by their edges. Below 768 pixels
 * the three panes ride a horizontal track, and one shows at a time.
 */
export function Workbench({
  view,
  onViewChange,
  accounts,
  folders,
  counts,
  conversations,
  onListNearEnd,
  sidebarFooter,
}: {
  view: View;
  onViewChange: (view: View) => void;
  accounts: readonly Account[];
  folders: readonly Folder[];
  counts: ViewCounts;
  /** Nothing until the view's first page arrives. */
  conversations: readonly ConversationSummary[] | undefined;
  /** Asks for the view's next page, if it has one. */
  onListNearEnd: () => void;
  sidebarFooter: ReactNode;
}) {
  const [selected, setSelected] = useState<ConversationId>();
  const stamps = useMemo(() => new Map(accounts.map(({ id, stamp }) => [id, stamp])), [accounts]);
  const [phonePane, setPhonePane] = useState<Pane>('list');
  const [sidebar, setSidebar] = usePanel(PANELS.sidebar);
  const [list, setList] = usePanel(PANELS.list);
  const [isResizing, setIsResizing] = useState(false);
  const isPhone = useMediaQuery(media.phone);
  const sidebarId = useId();
  const listId = useId();
  const { title, unread } = describeView(view, folders, counts);
  // Panes off a phone's screen are inert, so focus and assistive tech stay on the one in view.
  const isOffscreen = (pane: Pane) => isPhone && pane !== phonePane;

  return (
    <div {...stylex.props(styles.desk)}>
      <div
        {...stylex.props(
          styles.track,
          styles.columns(COLUMNS),
          trackAt[phonePane],
          isResizing && styles.resizing,
        )}
      >
        <div inert={isOffscreen('sidebar')} {...stylex.props(styles.pane)}>
          <Sidebar
            id={sidebarId}
            view={view}
            onSelect={(next) => {
              onViewChange(next);
              setPhonePane('list');
            }}
            accounts={accounts}
            folders={folders}
            counts={counts}
            isCollapsed={!isPhone && sidebar.isCollapsed}
            footer={
              <>
                <StatusLine accounts={accounts} isCollapsed={!isPhone && sidebar.isCollapsed} />
                {sidebarFooter}
              </>
            }
          />
          <PanelEdge
            spec={PANELS.sidebar}
            state={sidebar}
            label="Resize the sidebar"
            controls={sidebarId}
            onChange={setSidebar}
            onResizingChange={setIsResizing}
          />
        </div>
        <div inert={isOffscreen('list')} {...stylex.props(styles.pane)}>
          <ListPane
            id={listId}
            title={title}
            unread={unread}
            conversations={conversations}
            stamps={stamps}
            selected={selected}
            onSelect={(id) => {
              setSelected(id);
              setPhonePane('reader');
            }}
            onNearEnd={onListNearEnd}
            isCollapsed={!isPhone && list.isCollapsed}
            onExpand={() => setList({ ...list, isCollapsed: false })}
            onShowFolders={() => setPhonePane('sidebar')}
          />
          <PanelEdge
            spec={PANELS.list}
            state={list}
            label="Resize the conversation list"
            controls={listId}
            onChange={setList}
            onResizingChange={setIsResizing}
          />
        </div>
        <div inert={isOffscreen('reader')} {...stylex.props(styles.pane)}>
          <ReaderPane onBack={() => setPhonePane('list')} />
        </div>
      </div>
    </div>
  );
}

/** A view's title, and the unread count its header shows: Inbox's across accounts, or a folder's. */
function describeView(
  view: View,
  folders: readonly Folder[],
  counts: ViewCounts,
): { title: string; unread?: number } {
  switch (view.in) {
    case 'folder': {
      const { account, path } = view.folder;
      const folder = folders.find((each) => each.account === account && each.path === path);
      return { title: folder ? folderName(folder) : path, unread: folder?.unread };
    }
    case 'search':
      return { title: 'Search' };
    default:
      return {
        title: UNIFIED_VIEWS.find((unified) => unified.in === view.in)?.label ?? '',
        unread: view.in === 'inbox' ? counts.inbox : undefined,
      };
  }
}

const styles = stylex.create({
  desk: {
    height: '100dvh',
    overflow: 'hidden',
    backgroundColor: colorVars['--color-background-body'],
  },
  track: {
    display: { default: 'grid', [media.phone]: 'flex' },
    gap: { default: tm.deskGap, [media.phone]: 0 },
    padding: { default: tm.deskGap, [media.phone]: 0 },
    width: { default: '100%', [media.phone]: '300%' },
    height: '100%',
    // Panes and the phone track move on the layout easing, and nothing moves under reduced motion.
    transitionProperty: { default: 'grid-template-columns', [media.phone]: 'transform' },
    transitionDuration: {
      default: durationVars['--duration-medium'],
      [media.reducedMotion]: '0s',
    },
    transitionTimingFunction: tm.easeLayout,
  },
  columns: (columns: string) => ({ gridTemplateColumns: columns }),
  // An edge being dragged moves its panel with the pointer, not after it.
  resizing: {
    transitionDuration: '0s',
  },
  pane: {
    position: 'relative',
    minWidth: 0,
    minHeight: 0,
    height: '100%',
    flexBasis: { default: null, [media.phone]: 0 },
    flexGrow: { default: null, [media.phone]: 1 },
  },
});

const trackAt = stylex.create({
  sidebar: { transform: { default: null, [media.phone]: 'translateX(0)' } },
  list: { transform: { default: null, [media.phone]: 'translateX(calc(-100% / 3))' } },
  reader: { transform: { default: null, [media.phone]: 'translateX(calc(-200% / 3))' } },
});
