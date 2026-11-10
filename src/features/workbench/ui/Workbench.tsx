import { colorVars, durationVars, spacingVars } from '@astryxdesign/core/theme/tokens.stylex';
import * as stylex from '@stylexjs/stylex';
import { useQuery, useQueryClient } from '@tanstack/react-query';
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
import {
  marksOf,
  type Account,
  type ConversationId,
  type ConversationSummary,
  type Folder,
  type Message,
  type View,
} from '../../mail/core/index.ts';
import { conversationQuery, conversationsQuery } from '../../mailroom/client/index.ts';
import { draftIn, OutboxList, SendDraft, useOutboxCommands } from '../../outbox/index.ts';
import { ListPane } from './ListPane.tsx';
import { PanelEdge } from './PanelEdge.tsx';
import { PANELS } from './panels.ts';
import { ReaderPane, type Reading } from './ReaderPane.tsx';
import {
  NOTHING_SELECTED,
  rowChange,
  SearchContext,
  SearchField,
  SearchScope,
  select,
  TriageActions,
  triageCommands,
  useTriage,
  type Action,
  type SelectBy,
  type Selection,
} from '../../conversations/index.ts';
import { PickedActions, SelectionPane } from './SelectionPane.tsx';
import { workbenchCommands } from './commands.ts';
import {
  CommandButton,
  Commands,
  focusSearch,
  runCommandKey,
  ShortcutSheet,
  useCommandKeys,
  type Command,
} from '../../commands/index.ts';
import { Composer, composerCommands } from '../../composer/ui/index.ts';
import { isDocked, useComposing } from './useComposing.ts';

const NO_COMMANDS: readonly Command[] = [];
import { StatusLine } from './StatusLine.tsx';
import {
  folderName,
  Sidebar,
  UNIFIED_VIEWS,
  folderCommands,
  FolderDialog,
  viewCommands,
  type FolderQuestion,
  type ViewCounts,
} from '../../folders/index.ts';
import { useMediaQuery } from './useMediaQuery.ts';
import { usePanel } from './usePanel.ts';

type Pane = 'sidebar' | 'list' | 'reader';

/** The one search field, wherever it sits. It reads the search from `SearchContext`. */
const SEARCH_FIELD = <SearchField />;

/** What the sidebar is shown while a search is typed: no mailbox open, the same at every key. */
const SEARCHING: View = { in: 'search', text: '' };

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
  isFetching,
  onListNearEnd,
  sidebarFooter,
  extraCommands = NO_COMMANDS,
}: {
  view: View;
  onViewChange: (view: View) => void;
  accounts: readonly Account[];
  folders: readonly Folder[];
  counts: ViewCounts;
  /** Nothing until the view's first page arrives. */
  conversations: readonly ConversationSummary[] | undefined;
  /** Whether the view's rows are on their way. */
  isFetching: boolean;
  /** Asks for the view's next page, if it has one. */
  onListNearEnd: () => void;
  sidebarFooter: ReactNode;
  /** Commands from outside the workbench, such as the theme's, for the registry. */
  extraCommands?: readonly Command[];
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
  const { search, marks, searchBodies } = useSearch(view, onViewChange);
  // On a desktop the sidebar's box is the search field. On a phone, or while the sidebar is a rail,
  // the field sits above the list instead.
  const isFieldInSidebar = !isPhone && !sidebar.isCollapsed;
  // Panes off a phone's screen are inert, so focus and assistive tech stay on the one in view.
  const isOffscreen = (pane: Pane) => isPhone && pane !== phonePane;

  const { triage, undoLast, canUndo } = useTriage(view, folders);
  const composing = useComposing(selected);
  // A new message is from the account the view holds, or else the first.
  const writeFrom = scope ?? accounts[0];
  // On a phone, a new message closed with nothing open goes back to the list it was begun from.
  const closeComposer = () => {
    composing.close();
    if (selected === undefined) setPhonePane('list');
  };
  const write =
    writeFrom &&
    (() => {
      composing.write(writeFrom);
      setPhonePane('reader');
    });
  const [isSheetOpen, setSheetOpen] = useState(false);
  const [asking, setAsking] = useState<FolderQuestion>();
  const askForNewFolder = useCallback(
    (account: Account) => setAsking({ ask: 'create', account }),
    [],
  );
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
  const { replyIn } = composing;
  const readerActions = useCallback(
    ({ id, conversation, account }: Reading, place: 'bar' | 'island') => {
      const [, reply, replyAll] = composerCommands({
        write: undefined,
        reply: (all) => replyIn(conversation, all),
      });
      const draft = draftIn(conversation, folders);
      return (
        <>
          {reply && <CommandButton command={reply} />}
          {replyAll && place === 'bar' && <CommandButton command={replyAll} />}
          <TriageActions
            commands={triageCommands({
              accounts: [account],
              folders,
              isFlagged: conversation.some(({ flags }) => flags.flagged),
              isUnread: conversation.some(({ flags }) => !flags.seen),
              onTriage: (action) => latestTriageShown.current(action, id),
            })}
            isCompact={place === 'island'}
          />
          {draft && <SendDraft draft={draft} isCompact={place === 'island'} />}
        </>
      );
    },
    [folders, replyIn],
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
  // What's selected, as commands: the selection's own while several are picked, else the open one's.
  const selectedCommands =
    pickedRows.length === 0
      ? []
      : triageCommands({
          accounts: accounts.filter(({ id }) => pickedRows.some((row) => row.account === id)),
          folders,
          isFlagged: pickedRows.every(({ flagged }) => flagged),
          isUnread: pickedRows.some(({ unread }) => unread > 0),
          onTriage: (action) =>
            isMany || isPicking || selected === undefined
              ? triageSelection(action)
              : triageShown(action, selected),
        });
  const selectionActions = (place: 'bar' | 'island') => (
    <TriageActions commands={selectedCommands} isCompact={place === 'island'} />
  );

  // The open conversation's draft, if it has one, which Send sends. Only a change of draft redraws.
  const selectDraft = useCallback((messages: Message[]) => draftIn(messages, folders), [folders]);
  const { data: openDraft } = useQuery({
    ...conversationQuery(selected ?? ''),
    enabled: selected !== undefined,
    select: selectDraft,
  });
  const outbox = useOutboxCommands(selected === undefined ? undefined : openDraft);

  // The registry: every command the workbench can run now, gathered from each feature, which binds
  // their keys and feeds the palette and the shortcut sheet.
  const anchorAt = conversations?.findIndex(({ id }) => id === selection.anchor) ?? -1;
  const stepTo = (at: number) => {
    const row = conversations?.[at];
    return row && (() => pick(row.id, 'only'));
  };
  const commands = [
    ...selectedCommands,
    ...workbenchCommands({
      next: stepTo(anchorAt + 1),
      previous: anchorAt > 0 ? stepTo(anchorAt - 1) : undefined,
      back: composing.compose
        ? closeComposer
        : isPhone
          ? phonePane === 'list'
            ? undefined
            : () => setPhonePane('list')
          : isMany
            ? stopPicking
            : undefined,
      // While a send can still be taken back, Undo takes it back first.
      undo: outbox.undoSend ?? (canUndo ? undoLast : undefined),
      focusSearch,
      showShortcuts: () => setSheetOpen(true),
    }),
    ...composerCommands({
      write,
      reply: selected !== undefined && !isMany ? (all) => void composing.reply(all) : undefined,
    }),
    ...viewCommands(accounts, folders, openView),
    ...outbox.commands,
    ...folderCommands({ accounts, folders, view, ask: setAsking }),
    ...extraCommands,
  ];
  useCommandKeys(commands);
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

  const newMessage = commands.find(({ id }) => id === 'message.new');
  const { compose } = composing;
  const writing = compose && {
    composer: (
      <Suspense>
        <Composer
          key={composing.session}
          compose={compose}
          accounts={accounts}
          onDraft={(saved, older) => composing.noteDraft(compose, saved, older)}
          onClose={closeComposer}
        />
      </Suspense>
    ),
    isDocked: isDocked(compose),
  };

  return (
    <Commands value={commands}>
      <SearchContext value={search}>
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
                view={view.in === 'search' ? SEARCHING : view}
                onSelect={openView}
                accounts={accounts}
                folders={folders}
                counts={counts}
                isCollapsed={isSidebarRail}
                onNewFolder={askForNewFolder}
                header={isFieldInSidebar ? SEARCH_FIELD : undefined}
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
                below={
                  <>
                    {!isFieldInSidebar && SEARCH_FIELD}
                    {view.in === 'search' && (
                      <SearchScope
                        isFullText={view.fullText === true}
                        isSearching={isFetching}
                        onSearchBodies={searchBodies}
                      />
                    )}
                  </>
                }
                list={
                  view.in === 'outbox' && (
                    <Suspense>
                      <OutboxList
                        label={title}
                        stamps={stamps}
                        selected={selected}
                        onOpen={(id) => pick(id, 'only')}
                      />
                    </Suspense>
                  )
                }
                isSearch={view.in === 'search'}
                conversations={conversations}
                isUpdating={isFetching}
                marks={marks}
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
                write={newMessage && <CommandButton command={newMessage} />}
                actions={folderActions(commands)}
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
                  onMessageKey={runCommandKey}
                  writing={writing}
                  hidden={composing.hidden}
                  onOpenDraft={composing.openDraft}
                  onBack={() => setPhonePane('list')}
                />
              )}
            </div>
          </div>
        </div>
      </SearchContext>
      {asking && (
        <Suspense>
          <FolderDialog
            question={asking}
            onClose={() => setAsking(undefined)}
            onDeleted={({ account, path }) => {
              if (
                view.in === 'folder' &&
                view.folder.account === account &&
                view.folder.path === path
              ) {
                openView({ in: 'inbox' });
              }
            }}
          />
        </Suspense>
      )}
      {isSheetOpen && (
        <Suspense>
          <ShortcutSheet isOpen onClose={() => setSheetOpen(false)} />
        </Suspense>
      )}
    </Commands>
  );
}

/**
 * What the member searches for, as the view holds it, and how typing changes the view. Typing turns
 * the list into the search's results, clearing the field goes back to the view the search began
 * from, and asking for message bodies keeps the text and searches the servers too.
 */
function useSearch(view: View, onViewChange: (view: View) => void) {
  const queryClient = useQueryClient();
  const text = view.in === 'search' ? view.text : '';
  const latest = useRef(view);
  useLayoutEffect(() => {
    latest.current = view;
  });
  const returnTo = useRef<View>(view.in === 'search' ? { in: 'inbox' } : view);
  const onSearch = useCallback(
    (next: string) => {
      if (latest.current.in !== 'search') returnTo.current = latest.current;
      const searched: View = next === '' ? returnTo.current : { in: 'search', text: next };
      // The matches are asked for as the key goes down, not once the keystroke has been drawn.
      void queryClient.prefetchInfiniteQuery(conversationsQuery(searched));
      onViewChange(searched);
    },
    [onViewChange, queryClient],
  );
  const search = useMemo(() => ({ text, onSearch }), [text, onSearch]);
  const marks = useMemo(() => marksOf(text), [text]);
  const searchBodies = useCallback(
    () => onViewChange({ in: 'search', text, fullText: true }),
    [onViewChange, text],
  );
  return { search, marks, searchBodies };
}

/** Renaming and deleting the folder in view, as buttons in the list's header, when it's the member's own. */
function folderActions(commands: readonly Command[]): ReactNode {
  const own = ['folder.rename', 'folder.delete']
    .map((id) => commands.find((command) => command.id === id))
    .filter((command) => command !== undefined && command.isEnabled !== false);
  return own.length > 0
    ? own.map((command) => <CommandButton key={command!.id} command={command!} />)
    : undefined;
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
