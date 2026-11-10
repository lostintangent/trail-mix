import { colorVars, durationVars, spacingVars } from '@astryxdesign/core/theme/tokens.stylex';
import * as stylex from '@stylexjs/stylex';
import {
  startTransition,
  Suspense,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { media, tm } from '../../../app/theme/tokens.stylex.ts';
import { Toasts } from '../../../shared/toasts.tsx';
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
import { ReaderPane, type Reading } from './ReaderPane.tsx';
import {
  NOTHING_SELECTED,
  rowChange,
  select,
  TriageActions,
  useTriage,
  type Action,
  type SelectBy,
  type Selection,
} from '../../conversations/index.ts';
import { PickedActions, SelectionPane } from './SelectionPane.tsx';
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
  const [selection, setSelection] = useState<Selection>(NOTHING_SELECTED);
  const [isPicking, setPicking] = useState(false);
  // Picking ends with the last conversation picked.
  useEffect(() => {
    if (isPicking && selection.ids.length === 0) setPicking(false);
  }, [isPicking, selection.ids.length]);
  // One conversation selected is the one open in the reader. Several wait for an action together.
  const selected = selection.ids.length === 1 ? selection.ids[0] : undefined;
  const isMany = selection.ids.length > 1;
  const stamps = useMemo(() => new Map(accounts.map(({ id, stamp }) => [id, stamp])), [accounts]);
  const [phonePane, setPhonePane] = useState<Pane>('list');
  const [sidebar, setSidebar] = usePanel(PANELS.sidebar);
  const [list, setList] = usePanel(PANELS.list);
  const [isResizing, setIsResizing] = useState(false);
  const isPhone = useMediaQuery(media.phone);
  const sidebarId = useId();
  const listId = useId();
  const { title, unread, scope } = describeView(view, accounts, folders, counts);
  // Panes off a phone's screen are inert, so focus and assistive tech stay on the one in view.
  const isOffscreen = (pane: Pane) => isPhone && pane !== phonePane;

  const triage = useTriage(view, folders);
  // A conversation that leaves the list gives way to the one below it, or above it at the end. On a
  // phone, where the reader fills the screen, the list comes back instead. The list shows the
  // conversation gone at once, and the reader turns to the next one just after, so the frame that
  // shows the archive doesn't wait for the next conversation to render.
  const triageShown = (action: Action, id: ConversationId) => {
    if (rowChange(action, view) === 'gone') {
      const at = conversations?.findIndex((row) => row.id === id) ?? -1;
      const next = conversations?.[at + 1] ?? conversations?.[at - 1];
      if (isPhone) {
        setPhonePane('list');
        setSelection(NOTHING_SELECTED);
      } else if (at >= 0) {
        startTransition(() =>
          setSelection(next ? { ids: [next.id], anchor: next.id } : NOTHING_SELECTED),
        );
      }
    }
    triage(action, [id]);
  };
  // A selection that leaves the list is done with, and so is picking.
  const triageSelection = (action: Action) => {
    if (rowChange(action, view) === 'gone') {
      setSelection(NOTHING_SELECTED);
      setPicking(false);
    }
    triage(action, selection.ids);
  };
  const markRead = (id: ConversationId) => {
    if (conversations?.find((row) => row.id === id)?.unread) {
      triage({ do: 'read' }, [id], { quietly: true });
    }
  };
  // The reader's actions stay the same while the selection moves, so a held key doesn't redraw them.
  const latestTriageShown = useRef(triageShown);
  useLayoutEffect(() => {
    latestTriageShown.current = triageShown;
  });
  const readerActions = useCallback(
    ({ id, conversation, account }: Reading, place: 'bar' | 'island') => (
      <TriageActions
        accounts={[account]}
        folders={folders}
        isFlagged={conversation.some(({ flags }) => flags.flagged)}
        isUnread={conversation.some(({ flags }) => !flags.seen)}
        isCompact={place === 'island'}
        onTriage={(action) => latestTriageShown.current(action, id)}
      />
    ),
    [folders],
  );

  // Moving the selection re-renders only what shows it: the list, its two changed rows, and the
  // reader. The sidebar and the panel edges are memoized, and what they're handed stays the same.
  const openView = useCallback(
    (next: View) => {
      onViewChange(next);
      setPhonePane('list');
      setSelection((current) => (current.ids.length > 1 ? NOTHING_SELECTED : current));
      setPicking(false);
    },
    [onViewChange],
  );
  const order = useRef<ConversationId[]>([]);
  useLayoutEffect(() => {
    order.current = conversations?.map(({ id }) => id) ?? [];
  }, [conversations]);
  const pick = useCallback((id: ConversationId, by: SelectBy) => {
    setSelection((current) => select(current, id, by, order.current));
    if (by === 'only') setPhonePane('reader');
  }, []);
  const startPicking = useCallback((id: ConversationId) => {
    setPicking(true);
    setSelection({ ids: [id], anchor: id });
  }, []);
  // A swipe archives the row it moved, which leaves any selection that held it.
  const swipe = useCallback(
    (id: ConversationId) => {
      setSelection((current) => (current.ids.includes(id) ? NOTHING_SELECTED : current));
      triage({ do: 'archive' }, [id]);
    },
    [triage],
  );
  const stopPicking = () => {
    setPicking(false);
    setSelection(NOTHING_SELECTED);
  };
  const pickedRows = useMemo(
    () => conversations?.filter(({ id }) => selection.ids.includes(id)) ?? [],
    [conversations, selection.ids],
  );
  const selectionActions = (place: 'bar' | 'island') => (
    <TriageActions
      accounts={accounts.filter(({ id }) => pickedRows.some((row) => row.account === id))}
      folders={folders}
      isFlagged={pickedRows.length > 0 && pickedRows.every(({ flagged }) => flagged)}
      isUnread={pickedRows.some(({ unread }) => unread > 0)}
      isCompact={place === 'island'}
      onTriage={triageSelection}
    />
  );
  const isSidebarRail = !isPhone && sidebar.isCollapsed;
  const footer = useMemo(
    () => (
      <>
        <StatusLine accounts={accounts} isCollapsed={isSidebarRail} />
        {sidebarFooter}
      </>
    ),
    [accounts, isSidebarRail, sidebarFooter],
  );

  return (
    <div {...stylex.props(styles.desk)}>
      {/* On a phone, toasts rise above the island, where the pane's actions float. */}
      <Toasts
        layerInset={
          isPhone
            ? { blockEnd: `calc(${tm.target} + ${spacingVars['--spacing-1']} * 2)` }
            : undefined
        }
      />
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
            onSelect={openView}
            accounts={accounts}
            folders={folders}
            counts={counts}
            isCollapsed={isSidebarRail}
            footer={footer}
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
            scope={scope}
            conversations={conversations}
            stamps={stamps}
            selection={selection}
            isPicking={isPicking}
            onSelect={pick}
            onLongPress={startPicking}
            onSwipe={swipe}
            picked={
              <PickedActions count={selection.ids.length} onCancel={stopPicking}>
                <Suspense>{selectionActions('island')}</Suspense>
              </PickedActions>
            }
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
          {isMany && !isPhone ? (
            <SelectionPane count={selection.ids.length} onClear={stopPicking}>
              <Suspense>{selectionActions('bar')}</Suspense>
            </SelectionPane>
          ) : (
            <ReaderPane
              selected={selected}
              accounts={accounts}
              upcoming={neighbors(conversations, selected)}
              onShown={markRead}
              actions={readerActions}
              onBack={() => setPhonePane('list')}
            />
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * The conversations the member may open next, which the reader prepares ahead: those just below and
 * above the selected one, or the first ones while nothing is selected.
 */
function neighbors(
  conversations: readonly ConversationSummary[] | undefined,
  selected: ConversationId | undefined,
): ConversationId[] {
  if (!conversations) return [];
  if (selected === undefined) return conversations.slice(0, 2).map(({ id }) => id);
  const at = conversations.findIndex(({ id }) => id === selected);
  if (at < 0) return [];
  return [conversations[at + 1], conversations[at - 1]].flatMap((row) => (row ? [row.id] : []));
}

/**
 * A view's title, the unread count its header shows (Inbox's across accounts, or a folder's), and
 * the one account it holds, if it holds only one.
 */
function describeView(
  view: View,
  accounts: readonly Account[],
  folders: readonly Folder[],
  counts: ViewCounts,
): { title: string; unread?: number; scope?: Account } {
  switch (view.in) {
    case 'folder': {
      const { account, path } = view.folder;
      const folder = folders.find((each) => each.account === account && each.path === path);
      return {
        title: folder ? folderName(folder) : path,
        unread: folder?.unread,
        scope: accounts.find(({ id }) => id === account),
      };
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
