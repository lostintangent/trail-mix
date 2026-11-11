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
  type AccountId,
  type ConversationId,
  type ConversationSummary,
  type Folder,
  type Message,
  type MessageRef,
  type View,
} from '../../mail/core/index.ts';
import { conversationQuery, conversationsQuery, outboxQuery } from '../../mailroom/client/index.ts';
import {
  OutboxList,
  SendActions,
  sendCommands,
  useLeaving,
  useOutboxCommands,
  useSend,
} from '../../outbox/index.ts';
import { ListPane } from './ListPane.tsx';
import { PanelEdge } from './PanelEdge.tsx';
import { PANELS } from './panels.ts';
import { ReaderPane, type ActionsPlace, type Reading } from './ReaderPane.tsx';
import { ReaderPlace } from './ReaderPlace.tsx';
import { askAhead, sourceCommand, SourceDialog } from '../../reader/index.ts';
import {
  ConversationListSkeleton,
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
import { FoldToggle } from './FoldToggle.tsx';
import {
  CommandButton,
  PrimaryCommandButton,
  RegisteredCommandButton,
  Commands,
  focusSearch,
  runCommandKey,
  SEARCH_COMMAND,
  ShortcutSheet,
  useCommandKeys,
  useSteadyCommands,
  type Command,
} from '../../commands/index.ts';
import { Composer, composerCommands, type Sender, type Writing } from '../../composer/ui/index.ts';
import { isDocked, newestOf, useComposing } from './useComposing.ts';

const NO_COMMANDS: readonly Command[] = [];

/** The triage buttons as they're drawn while nothing is open or selected: all disabled. */
const NOTHING_TO_TRIAGE = triageCommands({
  accounts: [],
  folders: [],
  isFlagged: false,
  isUnread: false,
  onTriage: () => {},
}).map((command) => ({ ...command, isEnabled: false }));
import { StatusLine } from './StatusLine.tsx';
import {
  CREATE,
  folderName,
  Sidebar,
  UNIFIED_VIEWS,
  DeleteQuestion,
  FolderMenu,
  useFolderEditing,
  viewCommands,
  viewIcon,
  type FooterPlace,
  type SidebarRail,
  type ViewCounts,
} from '../../folders/index.ts';
import { useMediaQuery } from '../../../shared/useMediaQuery.ts';
import {
  accountCommands,
  isAccountCommand,
  AccountPage,
  RemoveQuestion,
  type AccountPageOf,
} from '../../accounts/index.ts';
import { memberCommands, MembersPage, operatorQuery } from '../../members/index.ts';

/** What can lie on the reader's sheet in place of a conversation. */
type SheetPage = AccountPageOf | { as: 'members' };
import { usePanel } from './usePanel.ts';

type Pane = 'sidebar' | 'list' | 'reader';

/** The one search field, wherever it sits. It reads the search from `SearchContext`. */
const SEARCH_FIELD = <SearchField />;

/**
 * New message, at the top of a desktop's sidebar. It reads its command as it renders, so the
 * sidebar, memoized around it, doesn't render again with every key.
 */
const NEW_MESSAGE = <PrimaryCommandButton id="message.new" />;

/** How a desktop's sidebar folds: to its rail, led by New message, with a button that holds still. */
const RAIL: SidebarRail = {
  width: PANELS.sidebar.rail,
  fold: <FoldToggle />,
  top: <RegisteredCommandButton id="message.new" isAccent />,
};

/** Where a phone's toasts rise to: above the island, where the pane's actions float. */
const ABOVE_ISLAND = { blockEnd: `calc(${tm.target} + ${spacingVars['--spacing-1']} * 2)` };

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
  hasMore,
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
  /** Whether the view has pages beyond those loaded. */
  hasMore: boolean;
  /** Whether the view's rows are on their way. */
  isFetching: boolean;
  /** Asks for the view's next page, if it has one. */
  onListNearEnd: () => void;
  sidebarFooter: ReactNode;
  /** Commands from outside the workbench, such as the theme's, for the registry. */
  extraCommands?: readonly Command[];
}) {
  const queryClient = useQueryClient();
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
  // On a desktop New message and the search field top the sidebar. Folded to its rail, New message
  // leads the rail and the field sits above the list, as it does on a phone.
  const isFieldInSidebar = !isPhone && !sidebar.isCollapsed;
  // Panes off a phone's screen are inert, so focus and assistive tech stay on the one in view.
  const isOffscreen = (pane: Pane) => isPhone && pane !== phonePane;

  const { triage, undoLast, canUndo } = useTriage(view, folders);
  // Drafts on their way can't be written on until their send is undone. Each lies at the end of its
  // conversation as a reply on its way instead, until the server's copy takes its place.
  const { data: outgoing } = useQuery(outboxQuery);
  const leaving = useLeaving();
  const composing = useComposing(selected, leaving.drafts);
  const { compose } = composing;
  // A new message is from the account the view holds, or else the first.
  const writeFrom = scope ?? accounts[0];
  const closeComposer = composing.close;
  // An account's page, or the Members page, lies where a new message's composer would, so writing
  // one closes it.
  const [page, setPage] = useState<SheetPage>();
  const [removing, setRemoving] = useState<Account>();
  const write =
    writeFrom &&
    (() => {
      setPage(undefined);
      composing.write(writeFrom);
    });
  const [isSheetOpen, setSheetOpen] = useState(false);
  // The conversation leaving the list, and where it was, until the selection has moved on from it.
  // Meanwhile it stays picked, and the moves either side of it and the reader's place count from
  // where it was, so the commands and what shows them don't change in the frame that shows it gone.
  const [vacating, setVacating] = useState<{ row: ConversationSummary; at: number }>();
  // A conversation that leaves the list gives way to the one below it, or above it at the end. On a
  // phone, where the reader fills the screen, the list comes back instead. The list shows the
  // conversation gone at once, and the reader turns to the next one just after, so the frame that
  // shows the archive doesn't wait for the next conversation to render.
  const triageShown = (action: Action, id: ConversationId) => {
    if (rowChange(action, view) === 'gone') {
      const at = conversations?.findIndex((row) => row.id === id) ?? -1;
      const leaving = conversations?.[at];
      const next = conversations?.[at + 1] ?? conversations?.[at - 1];
      if (isPhone) {
        setPhonePane('list');
        setSelection(NOTHING_SELECTED);
      } else if (leaving) {
        setVacating({ row: leaving, at });
        startTransition(() => {
          setSelection(next ? { ids: [next.id], anchor: next.id } : NOTHING_SELECTED);
          setVacating(undefined);
        });
      }
    }
    triage(action, [id]);
  };
  /**
   * Where a conversation sits in the list, or, while it leaves, where it was: the row that took its
   * place is the one after it.
   */
  const placeOf = useCallback(
    (id: ConversationId | undefined) => {
      const at = id === undefined ? -1 : (conversations?.findIndex((row) => row.id === id) ?? -1);
      return at < 0 && vacating !== undefined && vacating.row.id === id
        ? { at: vacating.at, after: vacating.at }
        : { at, after: at + 1 };
    },
    [conversations, vacating],
  );
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
  const { replyIn, replyTo } = composing;
  // A desktop's bar files and marks the conversation, and each of its messages holds its own Reply.
  // On a phone the marks sit at the top of the screen, and the island files it beside a Reply.
  // While the list shows, its header carries the open conversation's buttons, so the reader's bar
  // holds only its place. The reader takes them when it stands alone: on a phone, or with the list
  // folded to its rail.
  const isReaderAlone = isPhone || list.isCollapsed;
  const readerActions = useCallback(
    ({ id, conversation, account }: Reading, place: ActionsPlace) => {
      // A desktop shows the bar, and a phone the top and the island, so only those are drawn.
      if (isPhone === (place === 'bar')) return null;
      if (place === 'bar' && !isReaderAlone) return null;
      const triage = (
        <TriageActions
          commands={triageCommands({
            accounts: [account],
            folders,
            isFlagged: conversation.some(({ flags }) => flags.flagged),
            isUnread: conversation.some(({ flags }) => !flags.seen),
            onTriage: (action) => latestTriageShown.current(action, id),
          })}
          part={place === 'bar' ? 'all' : place === 'top' ? 'marking' : 'filing'}
        />
      );
      if (place !== 'island') return triage;
      const [, reply] = composerCommands({
        write: undefined,
        reply: (all) => replyIn(conversation, all),
      });
      return (
        <>
          {triage}
          {/* On a phone, Reply is the island's main action, at its far end. */}
          {reply && <CommandButton command={reply} primary="Reply" />}
        </>
      );
    },
    [folders, replyIn, isPhone, isReaderAlone],
  );
  // The reader's place renders again only as the list or the conversation shown changes.
  const readerPlace = useCallback(
    (shown: ConversationId) => (
      <ReaderPlace at={placeOf(shown).at + 1} of={conversations?.length ?? 0} hasMore={hasMore} />
    ),
    [placeOf, conversations, hasMore],
  );
  // A message's source shows over everything, whichever message it is.
  const [source, setSource] = useState<Message>();
  const messageActions = useCallback(
    (message: Message) => [
      ...composerCommands({ write: undefined, reply: (all) => replyTo(message, all) }).filter(
        ({ id }) => id !== 'message.new',
      ),
      sourceCommand(() => setSource(message)),
    ],
    [replyTo],
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
  // Folders are named in place in the sidebar, so naming one brings it into view.
  const revealSidebar = useCallback(() => {
    if (isPhone) setPhonePane('sidebar');
    else if (sidebar.isCollapsed) setSidebar({ ...sidebar, isCollapsed: false });
  }, [isPhone, sidebar, setSidebar]);
  const folderEditing = useFolderEditing({
    accounts,
    folders,
    view,
    open: onViewChange,
    reveal: revealSidebar,
  });
  // An account's page takes the reader's place, from nothing selected, where a phone slides to it.
  const openPage = useCallback(
    (page: SheetPage) => {
      closeComposer();
      setSelection(NOTHING_SELECTED);
      setPicking(false);
      setPage(page);
      setPhonePane('reader');
    },
    [closeComposer],
  );
  const closePage = useCallback(() => {
    setPage(undefined);
    if (isPhone) setPhonePane('list');
  }, [isPhone]);
  // The phone's ways between panes, the same functions every render, so the buttons they're on stay
  // drawn as they are while the list and the reader change.
  const showFolders = useCallback(() => setPhonePane('sidebar'), []);
  const backToList = useCallback(() => setPhonePane('list'), []);
  const accountsCommands = useMemo(
    () =>
      accountCommands({
        accounts,
        add: () => openPage({ as: 'add' }),
        edit: (account) => openPage({ as: 'edit', account: account.id }),
        remove: setRemoving,
        signIn: (account) => openPage({ as: 'edit', account: account.id, isSigningIn: true }),
      }),
    [accounts, openPage],
  );
  // A send held because its account's sign-in lapsed offers signing in again from its row.
  const lapsed = useMemo(
    () => new Set(accounts.flatMap(({ id, status }) => (status === 'needs-sign-in' ? [id] : []))),
    [accounts],
  );
  const signInAgain = useCallback(
    (account: AccountId) => openPage({ as: 'edit', account, isSigningIn: true }),
    [openPage],
  );
  const addAccount = useCallback(() => openPage({ as: 'add' }), [openPage]);
  // Only the operator has a Members page.
  const isOperator = useQuery(operatorQuery).data === true;
  const openMembers = useMemo(
    () => (isOperator ? () => openPage({ as: 'members' }) : undefined),
    [isOperator, openPage],
  );
  // A removed account's page closes, and so does a view of its folders.
  const removed = (account: Account) => {
    if (page?.as === 'edit' && page.account === account.id) closePage();
    if (view.in === 'folder' && view.folder.account === account.id) onViewChange({ in: 'inbox' });
  };
  const order = useRef<ConversationId[]>([]);
  useLayoutEffect(() => {
    order.current = conversations?.map(({ id }) => id) ?? [];
  }, [conversations]);
  const pick = useCallback((id: ConversationId, by: SelectBy) => {
    setPage(undefined);
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
  // A conversation about to be opened is asked for before the click lands.
  const ahead = useCallback(
    (id: ConversationId, isPressed: boolean) => askAhead(queryClient, id, { body: isPressed }),
    [queryClient],
  );
  // The list's subject shows at once while the rest of the conversation is on its way.
  const subjectOf = useCallback(
    (id: ConversationId) => conversations?.find((row) => row.id === id)?.subject,
    [conversations],
  );
  const stopPicking = () => {
    setPicking(false);
    setSelection(NOTHING_SELECTED);
  };
  const pickedRows = useMemo(() => {
    const rows = conversations?.filter(({ id }) => selection.ids.includes(id)) ?? [];
    return vacating && selection.ids.includes(vacating.row.id) && !rows.includes(vacating.row)
      ? [...rows, vacating.row]
      : rows;
  }, [conversations, selection.ids, vacating]);
  // What's selected, as commands: the selection's own while several are picked, else the open one's.
  const selectedCommands =
    pickedRows.length === 0
      ? []
      : triageCommands({
          accounts: accounts.filter(({ id }) => pickedRows.some((row) => row.account === id)),
          folders,
          isFlagged: pickedRows.every(({ flagged }) => flagged),
          isUnread: pickedRows.some(({ unread }) => unread > 0),
          // One leaving the list is done with, until the selection has moved on from it.
          onTriage: (action) =>
            selected !== undefined && selected === vacating?.row.id
              ? undefined
              : isMany || isPicking || selected === undefined
                ? triageSelection(action)
                : triageShown(action, selected),
        });
  const selectionActions = (place: 'bar' | 'island') => (
    <TriageActions commands={selectedCommands} isCompact={place === 'island'} />
  );
  // At the head of the list on a desktop: what can be done to the open conversation or the
  // selection, drawn disabled while there's neither, so nothing in the header moves.
  const listTriage = isReaderAlone
    ? undefined
    : {
        label: isMany ? 'Selected conversations' : 'Conversation',
        actions: (
          <Suspense>
            <TriageActions
              commands={selectedCommands.length > 0 ? selectedCommands : NOTHING_TO_TRIAGE}
            />
          </Suspense>
        ),
      };

  const outbox = useOutboxCommands();

  // Send sends what the open composer holds, once it's saved, and Undo brings the composer back as
  // it was, under its conversation if that's still the one open.
  const send = useSend();
  const sender = useRef<Sender['current']>(undefined);
  const [isSendable, setSendable] = useState(false);
  const shownNow = useRef(selected);
  useLayoutEffect(() => {
    shownNow.current = selected;
  });
  // A reply is on its way at the end of its conversation in the frame its composer closes, and
  // leaves it again if the Mailroom refuses it or Undo takes it back.
  const sendWritten = (draft: MessageRef, at: string | undefined, writing: Writing) => {
    const from = { conversation: selected, isDocked: compose !== undefined && isDocked(compose) };
    const pressedAt = Date.now();
    leaving.pressed(draft, {
      in: from.isDocked ? from.conversation : undefined,
      written: writing.markdown,
      at,
      pressedAt,
    });
    void send(draft, {
      at,
      pressedAt,
      onUndone: (back) => {
        leaving.forgotten(back);
        composing.resume(writing, back, from.isDocked && shownNow.current === from.conversation);
      },
    }).then((outgoing) => {
      if (!outgoing) leaving.forgotten(draft);
    });
  };
  const writingCommands = compose
    ? sendCommands({
        onSend: (at) => sender.current?.(at),
        isEnabled: isSendable,
        shortcut: 'Mod+Enter',
      })
    : [];

  // The registry: every command the workbench can run now, gathered from each feature, which binds
  // their keys and feeds the palette and the shortcut sheet.
  const anchor = placeOf(selection.anchor);
  const stepTo = (at: number) => {
    const row = conversations?.[at];
    return row && (() => pick(row.id, 'only'));
  };
  // The registry is made anew each render, as the selection moves, but its commands keep their
  // identity while they look the same, so what draws them and the palette render only on a change.
  const commands = useSteadyCommands([
    ...selectedCommands,
    ...workbenchCommands({
      next: stepTo(anchor.after),
      previous: anchor.at > 0 ? stepTo(anchor.at - 1) : undefined,
      back: page
        ? closePage
        : composing.compose
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
      fold: isPhone
        ? undefined
        : {
            isFolded: sidebar.isCollapsed,
            toggle: () => setSidebar({ ...sidebar, isCollapsed: !sidebar.isCollapsed }),
          },
      showShortcuts: () => setSheetOpen(true),
    }),
    ...composerCommands({
      write,
      reply: selected !== undefined && !isMany ? (all) => void composing.reply(all) : undefined,
    }),
    sourceCommand(
      selected !== undefined && !isMany
        ? () =>
            void queryClient
              .ensureQueryData(conversationQuery(selected))
              .then((conversation) => setSource(newestOf(conversation)))
        : undefined,
    ),
    ...viewCommands(accounts, folders, openView),
    ...outbox.commands,
    ...folderEditing.commands,
    ...accountsCommands,
    ...memberCommands(openMembers),
    ...writingCommands,
    ...extraCommands,
  ]);
  useCommandKeys(commands);
  const footer = useCallback(
    (place: FooterPlace) => (
      <>
        <StatusLine accounts={accounts} isCollapsed={place === 'rail'} />
        {sidebarFooter}
      </>
    ),
    [accounts, sidebarFooter],
  );
  // What an account's menu in the sidebar lists: a new folder at its top, then its own commands.
  // It asks the registry as the menu opens, so the sidebar doesn't render again as that changes.
  const latestCommands = useRef(commands);
  useLayoutEffect(() => {
    latestCommands.current = commands;
  });
  const accountActions = useCallback(
    (account: Account) =>
      latestCommands.current.filter(
        (command) => command.id === `${CREATE}${account.id}` || isAccountCommand(command, account),
      ),
    [],
  );

  const newMessage = commands.find(({ id }) => id === 'message.new');
  const searchAndCommands = commands.find(({ id }) => id === SEARCH_COMMAND);
  const writing =
    compose &&
    ({
      composer: (
        <Suspense>
          <Composer
            key={composing.session}
            compose={compose}
            accounts={accounts}
            onDraft={(saved, older) => composing.noteDraft(compose, saved, older)}
            onSend={sendWritten}
            sender={sender}
            onSendable={setSendable}
            sendActions={
              <Suspense>
                <SendActions
                  commands={writingCommands}
                  onPick={(at) => sender.current?.(at)}
                  isCompact={isPhone}
                />
              </Suspense>
            }
            isSheet={isPhone}
            onClose={closeComposer}
          />
        </Suspense>
      ),
      // On a phone the composer rises over everything, wherever it was begun.
      place: isPhone ? 'over' : isDocked(compose) ? 'docked' : 'filled',
    } as const);

  return (
    <Commands value={commands}>
      <SearchContext value={search}>
        <div {...stylex.props(styles.desk)}>
          {/* On a phone, toasts rise above the island, where the pane's actions float. */}
          <Toasts layerInset={isPhone ? ABOVE_ISLAND : undefined} />
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
                rail={isPhone ? undefined : RAIL}
                isCollapsed={sidebar.isCollapsed}
                // While its edge is dragged, the tree follows the edge.
                expandedWidth={isPhone || isResizing ? undefined : sidebar.width}
                editing={folderEditing.editing}
                onEdited={folderEditing.onEdited}
                folderActions={folderEditing.actionsFor}
                accountActions={accountActions}
                onAddAccount={addAccount}
                onMembers={openMembers}
                header={isPhone ? undefined : NEW_MESSAGE}
                search={isFieldInSidebar ? SEARCH_FIELD : undefined}
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
                icon={viewIcon(view, folders)}
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
                    <Suspense fallback={<ConversationListSkeleton label={title} />}>
                      <OutboxList
                        label={title}
                        stamps={stamps}
                        lapsed={lapsed}
                        onSignIn={signInAgain}
                        selected={selected}
                        onOpen={(id) => pick(id, 'only')}
                      />
                    </Suspense>
                  )
                }
                viewIn={view.in}
                conversations={conversations}
                isUpdating={isFetching}
                marks={marks}
                stamps={stamps}
                selection={selection}
                isPicking={isPicking}
                onSelect={pick}
                onLongPress={startPicking}
                onSwipe={swipe}
                onAhead={ahead}
                picked={
                  <PickedActions count={selection.ids.length} onCancel={stopPicking}>
                    <Suspense>{selectionActions('island')}</Suspense>
                  </PickedActions>
                }
                onNearEnd={onListNearEnd}
                isCollapsed={!isPhone && list.isCollapsed}
                onExpand={() => setList({ ...list, isCollapsed: false })}
                onShowFolders={showFolders}
                island={
                  <>
                    {searchAndCommands && <CommandButton command={searchAndCommands} />}
                    {newMessage && <CommandButton command={newMessage} primary="Write" />}
                  </>
                }
                actions={
                  view.in === 'folder' && (
                    <Suspense>
                      <FolderMenu commands={folderEditing.commands} />
                    </Suspense>
                  )
                }
                triage={listTriage}
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
                  {isReaderAlone && <Suspense>{selectionActions('bar')}</Suspense>}
                </SelectionPane>
              ) : (
                <ReaderPane
                  selected={selected}
                  accounts={accounts}
                  folders={folders}
                  upcoming={neighbors(conversations, selected)}
                  onShown={markRead}
                  actions={readerActions}
                  place={readerPlace}
                  actionsFor={messageActions}
                  onMessageKey={runCommandKey}
                  writing={writing}
                  hidden={composing.hidden}
                  leaving={leaving.all}
                  onOpenDraft={composing.openDraft}
                  subjectOf={subjectOf}
                  page={
                    page?.as === 'members' ? (
                      <MembersPage />
                    ) : page ? (
                      <AccountPage
                        page={page}
                        accounts={accounts}
                        onClose={closePage}
                        onRemove={setRemoving}
                      />
                    ) : undefined
                  }
                  onBack={page ? closePage : backToList}
                />
              )}
            </div>
          </div>
        </div>
      </SearchContext>
      {removing && (
        <Suspense>
          <RemoveQuestion
            account={removing}
            waiting={(outgoing ?? []).filter(({ draft }) => draft.account === removing.id).length}
            onRemoved={removed}
            onClose={() => setRemoving(undefined)}
          />
        </Suspense>
      )}
      {folderEditing.deleting && (
        <Suspense>
          <DeleteQuestion
            folder={folderEditing.deleting}
            folders={folders}
            onDelete={folderEditing.confirmDelete}
            onClose={folderEditing.closeDelete}
          />
        </Suspense>
      )}
      {source && (
        <Suspense>
          <SourceDialog message={source} onClose={() => setSource(undefined)} />
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
