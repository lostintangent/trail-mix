import { colorVars, durationVars, spacingVars } from '@astryxdesign/core/theme/tokens.stylex';
import * as stylex from '@stylexjs/stylex';
import { hashKey, useQuery, useQueryClient } from '@tanstack/react-query';
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
  bundlePartsOf,
  isBundle,
  marksOf,
  repositoryAddressOf,
  sameRef,
  threadAddressOf,
  type Account,
  type AccountId,
  type BundleId,
  type ConversationId,
  type Folder,
  type ListItem,
  type Message,
  type MessageRef,
  type Place,
  type View,
} from '../../mail/core/index.ts';
import {
  bundleQuery,
  conversationQuery,
  conversationsQuery,
  MATCHES_LISTED,
  outboxQuery,
  thisDeviceQuery,
  useIsCaughtUp,
} from '../../mailroom/client/index.ts';
import {
  isDraftsView,
  leavesDrafts,
  OutboxList,
  SendActions,
  useSendCommands,
  type LeavingSends,
  useLeavingToasts,
  useOutboxCommands,
  useSend,
} from '../../outbox/index.ts';
import { ListPane } from './ListPane.tsx';
import { PanelEdge } from './PanelEdge.tsx';
import { PANELS } from './panels.ts';
import { useReadMark } from './useReadMark.ts';
import { ReaderPane, type Acting, type ActionsPlace, type ReaderSheet } from './ReaderPane.tsx';
import { ReaderPlace } from './ReaderPlace.tsx';
import {
  askAhead,
  BundleReader,
  BundleSkeleton,
  ConversationUnopened,
  lightPaperCommand,
  preloadBundleReader,
  setLightPaper,
  sourceCommand,
  SourceDialog,
  useDarkTheme,
  useUnsubscribeCommand,
} from '../../reader/index.ts';
import {
  ConversationListSkeleton,
  gitHubCommand,
  isSameSelection,
  NOTHING_SELECTED,
  rowChange,
  SearchContext,
  SearchField,
  SearchScope,
  select,
  TriageActions,
  triageCommands,
  useBundle,
  useTriage,
  type Action,
  placesOf,
  type Listed,
  type SelectBy,
  type Selection,
} from '../../conversations/index.ts';
import { PickedActions, SelectionPane } from './SelectionPane.tsx';
import { OPEN_SETTINGS, workbenchCommands } from './commands.ts';
import { FoldToggle } from './FoldToggle.tsx';
import {
  CommandButton,
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
import {
  Composer,
  composerCommands,
  ComposerSkeleton,
  isDocked,
  useIsReplyOnItsWay,
  type Sender,
  type Writing,
} from '../../composer/ui/index.ts';
import { newestOf, useComposing } from './useComposing.ts';

/** No commands from outside the workbench. */
const noCommands = (): readonly Command[] => [];

/**
 * How many threads on each side of the one open are fetched, so a held J or K finds the next page
 * there before it reaches it.
 */
const THREADS_AHEAD = 10;

import { useReach, type Reach } from '../../offline/index.ts';
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
  type SidebarRail,
  type ViewCounts,
} from '../../folders/index.ts';
import { useMediaQuery } from '../../../shared/useMediaQuery.ts';
import {
  accountCommands,
  isAccountCommand,
  AccountPage,
  EraseQuestion,
  RemoveQuestion,
  type AccountPageOf,
} from '../../accounts/index.ts';
import { memberCommands, operatorQuery } from '../../members/index.ts';

/**
 * Where Settings opens: at one of its sections, or at the accent, whose picker it opens too. It opens
 * at its top otherwise.
 */
export type SettingsAt = 'notifications' | 'accent' | 'members';

/** What can lie on the reader's sheet in place of a conversation. */
type SheetPage = AccountPageOf | { as: 'settings'; at?: SettingsAt };
import { usePanel } from './usePanel.ts';

type Pane = 'sidebar' | 'list' | 'reader';

/** The one search field, wherever it sits. It reads the search from `SearchContext`. */
const SEARCH_FIELD = <SearchField />;
/** The same field in the sidebar's head, beside the fold button, with fewer words. */
const SIDEBAR_SEARCH_FIELD = <SearchField isCompact />;

/**
 * New message, at the foot of a desktop's sidebar and on its rail, as a small button with the accent
 * fill, the sidebar's one primary button. It reads its command as it renders, so the sidebar,
 * memoized around it, doesn't render again with every key.
 */
const NEW_MESSAGE = <RegisteredCommandButton id="message.new" isAccent />;

/** The Settings gear at the foot of the sidebar, drawn from its command. */
const SETTINGS_GEAR = <RegisteredCommandButton id={OPEN_SETTINGS} />;

/** What a list says beside its title while the device can't reach its Mailroom. */
const OFFLINE: Record<Exclude<Reach, 'online'>, { said: string; more?: string }> = {
  offline: { said: 'Offline' },
  'offline-kept': { said: 'Offline', more: 'kept mail' },
};

/** How a desktop's sidebar folds: to its rail, with a button that holds still. */
const RAIL: SidebarRail = {
  width: PANELS.sidebar.rail,
  fold: <FoldToggle />,
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
  place,
  onPlaceChange,
  onBack,
  accounts,
  folders,
  counts,
  conversations,
  isFetching,
  onListShown,
  settings,
  extraCommands = noCommands,
  leaving,
}: {
  /** Where the member is, as the address holds it: the view, and the conversation open in it. */
  place: Place;
  /** Moves the place, and the address with it: pushed, so Back returns to where it was, or replaced. */
  onPlaceChange: (place: Place, history: 'push' | 'replace') => void;
  /** Goes back to where the address was before, as the browser's Back does. */
  onBack: () => void;
  accounts: readonly Account[];
  folders: readonly Folder[];
  counts: ViewCounts;
  /** The view's whole list, with places not yet fetched empty. Nothing until its first page arrives. */
  conversations: Listed<ListItem> | undefined;
  /** Whether the view's rows are on their way. */
  isFetching: boolean;
  /** Says which rows the list shows, so the pages they lie on are fetched. */
  onListShown: (first: number, last: number, selected: number) => void;
  /** Settings, which opens as a page in the reader's place, at its top or where it's asked to. */
  settings: (at: SettingsAt | undefined) => ReactNode;
  /** Commands from outside the workbench, such as the accent's, made with a way to open Settings. */
  extraCommands?: (openSettings: (at?: SettingsAt) => void) => readonly Command[];
  /** The sends this device follows, which the counts and the Drafts list read too. */
  leaving: LeavingSends;
}) {
  const queryClient = useQueryClient();
  const { view } = place;
  // The conversation or bundle the address opens is the one selected, from the first render.
  const [selection, setSelection] = useState<Selection>(() => openOnly(place.bundle ?? place.open));
  const [isPicking, setPicking] = useState(false);
  // Picking ends with the last conversation picked.
  useEffect(() => {
    if (isPicking && selection.ids.length === 0) setPicking(false);
  }, [isPicking, selection.ids.length]);
  // One conversation selected is the one open in the reader. Several wait for an action together.
  const selected = selection.ids.length === 1 ? selection.ids[0] : undefined;
  const isMany = selection.ids.length > 1;
  // A bundle selected lies open in the reader, and one of its threads may lie open in its place,
  // until the selection moves on from the bundle.
  const bundleOpen = selected !== undefined && bundlePartsOf(selected) ? selected : undefined;
  const [threadIn, setThreadIn] = useState(() =>
    place.bundle !== undefined && place.open !== undefined
      ? { bundle: place.bundle, open: place.open }
      : undefined,
  );
  if (threadIn !== undefined && threadIn.bundle !== bundleOpen) setThreadIn(undefined);
  const thread = threadIn?.bundle === bundleOpen ? threadIn?.open : undefined;
  // The conversation the reader shows: the one selected, or the thread open in the bundle selected.
  const opened = bundleOpen === undefined ? selected : thread;
  const inBundle = useBundle(bundleOpen);
  const threadAt = thread === undefined ? -1 : (inBundle.places.get(thread) ?? -1);
  const threadRow = inBundle.threads?.[threadAt];
  // While a thread is open, the threads beside it are fetched at once, so J and K step on past its
  // page without waiting.
  const showThreads = inBundle.show;
  useEffect(() => {
    if (threadAt >= 0) {
      showThreads(threadAt - THREADS_AHEAD, threadAt + THREADS_AHEAD, threadAt, true);
    }
  }, [showThreads, threadAt]);
  // The thread last open in the bundle, which the bundle shows in sight when the member returns.
  const [cameFrom, setCameFrom] = useState(threadIn);
  if (thread !== undefined && cameFrom?.open !== thread) setCameFrom(threadIn);
  const stamps = useMemo(() => new Map(accounts.map(({ id, stamp }) => [id, stamp])), [accounts]);
  // A row's avatar is its newest sender other than the member, by any of their addresses.
  const selves = useMemo(
    () => new Set(accounts.map(({ address }) => address.toLowerCase())),
    [accounts],
  );
  // Stamps mark rows only in a list that mixes accounts.
  const mixesAccounts = view.in !== 'folder' && accounts.length > 1;
  // On a phone, an address with a conversation opens on the reader, with no slide to it.
  const [phonePane, setPhonePane] = useState<Pane>(() =>
    place.open !== undefined || place.bundle !== undefined ? 'reader' : 'list',
  );
  const [sidebar, setSidebar] = usePanel(PANELS.sidebar);
  const [list, setList] = usePanel(PANELS.list);
  const [isResizing, setIsResizing] = useState(false);
  const isPhone = useMediaQuery(media.phone);
  // The view that opens at its newest conversation once its list is known, as one does that arrives
  // naming none.
  const [opening, setOpening] = useState(() =>
    place.open === undefined && place.bundle === undefined && opensNewest(view, isPhone)
      ? view
      : undefined,
  );
  const sidebarId = useId();
  const listId = useId();
  const { title, unread, scope } = describeView(view, accounts, folders, counts);
  // An empty list while an account the view holds is on its first sync, or before the page has
  // caught up with its Mailroom, may be mail on its way, which stands as skeleton rows. Search and
  // the Outbox say what they found at once.
  const isCaughtUp = useIsCaughtUp();
  const isFilling =
    view.in !== 'search' &&
    view.in !== 'outbox' &&
    (!isCaughtUp || (scope ? [scope] : accounts).some(({ status }) => status === 'syncing'));
  const { move, onViewChange, chooseView, written, pushed } = useAddress({
    place,
    onPlaceChange,
    bundle: bundleOpen,
    open: opened,
    isMany,
    // The conversation or bundle a place names is the one selected, with the thread it names open
    // in the bundle, and a view that names none opens at its newest.
    arrive: ({ view, bundle, open }) => {
      setSelection(openOnly(bundle ?? open));
      setThreadIn(bundle !== undefined && open !== undefined ? { bundle, open } : undefined);
      setPhonePane(bundle !== undefined || open !== undefined ? 'reader' : 'list');
      setOpening(
        bundle === undefined && open === undefined && opensNewest(view, isPhone) ? view : undefined,
      );
    },
    // A thread gone from its bundle leaves the bundle open.
    close: () => {
      if (bundleOpen !== undefined) {
        setThreadIn(undefined);
        return;
      }
      setSelection(NOTHING_SELECTED);
      setPhonePane('list');
    },
  });
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
  const composing = useComposing(opened, leaving.drafts);
  const { compose } = composing;
  // A new message is from the account the view holds, or else the first.
  const writeFrom = scope ?? accounts[0];
  const closeComposer = composing.close;
  // An account's page, or Settings, lies where a new message's composer would, so writing one
  // closes it.
  const [page, setPage] = useState<SheetPage>();
  const [removing, setRemoving] = useState<Account>();
  const [isErasing, setErasing] = useState(false);
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
  const [vacating, setVacating] = useState<{ row: ListItem; at: number }>();
  // Where each fetched conversation lies, so finding one never reads the whole list.
  const places = useMemo(
    () => (conversations ? placesOf(conversations) : NO_PLACES),
    [conversations],
  );
  const rowOf = useCallback(
    (id: ConversationId) => conversations?.[places.get(id) ?? -1],
    [conversations, places],
  );
  // A conversation that leaves the list gives way to the one below it, or above it at the end. On a
  // phone, where the reader fills the screen, the list comes back instead. The list shows the
  // conversation gone at once, and the reader turns to the next one just after, so the frame that
  // shows the archive doesn't wait for the next conversation to render.
  const giveWay = (id: ConversationId): Selection => {
    const at = places.get(id) ?? -1;
    const leaving = conversations?.[at];
    const next = conversations?.[at + 1] ?? conversations?.[at - 1];
    if (isPhone) {
      setPhonePane('list');
      setSelection(NOTHING_SELECTED);
      return NOTHING_SELECTED;
    }
    if (!leaving) return selection;
    const left = next ? { ids: [next.id], anchor: next.id } : NOTHING_SELECTED;
    setVacating({ row: leaving, at });
    startTransition(() => {
      setSelection(left);
      setVacating(undefined);
    });
    return left;
  };
  // The selection, whether the member is picking, and the phone's pane as they are now, which a
  // refused triage puts back.
  const now = useRef({ selection, isPicking, phonePane });
  useLayoutEffect(() => {
    now.current = { selection, isPicking, phonePane };
  });
  /**
   * A triage the server refuses puts its rows back, so a selection it moved on to `left` comes back
   * too, as nothing happened, unless the member has moved it since.
   */
  const backIfRefused = useCallback((left: Selection) => {
    const before = now.current;
    return () => {
      if (!isSameSelection(now.current.selection, left)) return;
      setSelection(before.selection);
      setPicking(before.isPicking);
      setPhonePane(before.phonePane);
    };
  }, []);
  const triageShown = (action: Action, id: ConversationId): void => {
    if (bundleOpen !== undefined && id !== bundleOpen) return triageThread(action, id, bundleOpen);
    if (rowChange(action, view) !== 'gone') return triage(action, [id]);
    const onRefused = backIfRefused(giveWay(id));
    triage(action, [id], { onRefused });
  };
  /**
   * A thread of the bundle open, triaged in the bundle's list. One that leaves it gives way to the
   * thread below it, or above it at the end, and on a phone to the bundle. The bundle's last thread
   * takes the bundle with it, as triaging its row does.
   */
  const triageThread = (action: Action, id: ConversationId, bundle: BundleId) => {
    if (rowChange(action, view) !== 'gone') return triage(action, [id], { in: bundle });
    const threads = inBundle.threads ?? [];
    if (threads.length <= 1) return triageShown(action, bundle);
    const at = inBundle.places.get(id) ?? -1;
    const next = threads[at + 1] ?? threads[at - 1];
    setThreadIn(next && !isPhone ? { bundle, open: next.id } : undefined);
    triage(action, [id], { in: bundle, onRefused: () => setThreadIn({ bundle, open: id }) });
  };
  /**
   * Where a conversation sits in the list, or, while it leaves, where it was: the row that took its
   * place is the one after it.
   */
  const placeOf = useCallback(
    (id: ConversationId | undefined) => {
      const at = id === undefined ? -1 : (places.get(id) ?? -1);
      return at < 0 && vacating !== undefined && vacating.row.id === id
        ? { at: vacating.at, after: vacating.at }
        : { at, after: at + 1 };
    },
    [places, vacating],
  );
  // A selection that leaves the list is done with, and so is picking.
  const triageSelection = (action: Action) => {
    if (rowChange(action, view) !== 'gone') return triage(action, selection.ids);
    const onRefused = backIfRefused(NOTHING_SELECTED);
    setSelection(NOTHING_SELECTED);
    setPicking(false);
    triage(action, selection.ids, { onRefused });
  };
  // Opening a conversation with no network, as from what the installed app kept, leaves it
  // unread, since the mark couldn't land and nobody asked for it.
  const reach = useReach();
  const markRead = (id: ConversationId) => {
    if (reach !== 'online') return;
    const row = rowOf(id);
    if (row !== undefined) {
      if (!isBundle(row) && row.unread) triage({ do: 'read' }, [id], { quietly: true });
      return;
    }
    // A thread is read in its bundle's list.
    const inThreads = inBundle.threads?.[inBundle.places.get(id) ?? -1];
    if (bundleOpen !== undefined && inThreads?.unread) {
      triage({ do: 'read' }, [id], { quietly: true, in: bundleOpen });
    }
  };
  const readMark = useReadMark({ selected: opened, markRead });
  // The reader's actions stay the same while the selection moves, so a held key doesn't redraw them.
  const latestTriageShown = useRef(triageShown);
  useLayoutEffect(() => {
    latestTriageShown.current = triageShown;
  });
  const { replyIn, replyTo } = composing;
  // A desktop's reader bar files and marks the conversation, with its place and arrows at the far
  // end. On a phone, marks sit at the top of the screen and filing sits in the island beside Reply.
  const readerActions = useCallback(
    ({ id, account, isFlagged, isUnread, conversation }: Acting, place: ActionsPlace) => {
      // A desktop shows the bar, and a phone the top and island, so only those are drawn.
      if (isPhone === (place === 'bar')) return null;
      const triage = (
        <TriageActions
          commands={triageCommands({
            accounts: [account],
            folders,
            isFlagged,
            isUnread,
            onTriage: (action) => latestTriageShown.current(action, id),
          })}
          part={place === 'bar' ? 'all' : place === 'top' ? 'marking' : 'filing'}
        />
      );
      if (place !== 'island' || !conversation) return triage;
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
    [folders, replyIn, isPhone],
  );
  // The reader's place renders again only as the list or the conversation shown changes. A thread's
  // place is in its bundle.
  const threadsCount = inBundle.bundle?.threads ?? 0;
  const readerPlace = useCallback(
    (shown: ConversationId) =>
      shown === thread ? (
        <ReaderPlace at={threadAt + 1} of={threadsCount} />
      ) : (
        <ReaderPlace at={placeOf(shown).at + 1} of={conversations?.length ?? 0} />
      ),
    [placeOf, conversations, thread, threadAt, threadsCount],
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
  // Choosing a view opens it afresh, at its newest conversation where it opens one.
  const openView = useCallback(
    (next: View) => {
      chooseView(next);
      setPhonePane('list');
      setSelection(NOTHING_SELECTED);
      setPicking(false);
      setOpening(opensNewest(next, isPhone) ? next : undefined);
    },
    [chooseView, isPhone],
  );
  // Before the frame is drawn, so the reader shows no empty sheet between the two. A list still
  // empty may be filling, as a new member's first sync fills it, so the view waits for its newest,
  // unless the member opens something of their own first: a conversation, a message or a page.
  const { openedByView, openedByMember } = readMark;
  useLayoutEffect(() => {
    if (opening === undefined) return;
    if (opening !== view || selected !== undefined || compose !== undefined || page !== undefined) {
      setOpening(undefined);
      return;
    }
    const newest = conversations?.[0];
    if (newest === undefined) return;
    setOpening(undefined);
    // A member's pick made in this same moment, as a key held for a row just arrived, wins.
    setSelection((current) =>
      current.ids.length > 0 ? current : { ids: [newest.id], anchor: newest.id },
    );
    // Opening a bundle reads nothing.
    if (!isBundle(newest)) openedByView(newest.id);
  }, [opening, view, selected, compose, page, conversations, openedByView]);
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
  // Closing a page leaves the view as if it had just arrived: on a desktop, its newest opens.
  const closePage = useCallback(() => {
    setPage(undefined);
    if (isPhone) setPhonePane('list');
    else if (opensNewest(latestPlace.current.view, false)) setOpening(latestPlace.current.view);
  }, [isPhone]);
  // The phone's ways between panes, the same functions every render, so the buttons they're on stay
  // drawn as they are while the list and the reader change.
  const showFolders = useCallback(() => setPhonePane('sidebar'), []);
  // Back from a conversation on a phone is the browser's Back where opening it pushed the address,
  // and otherwise takes the conversation out of the address.
  const latestPlace = useRef(place);
  useLayoutEffect(() => {
    latestPlace.current = place;
  });
  // On a phone, opening a conversation pushes the address, so Back slides from it to its list.
  const isPhoneNow = useRef(isPhone);
  useLayoutEffect(() => {
    isPhoneNow.current = isPhone;
  });
  const backToList = useCallback(() => {
    const { view, bundle, open } = latestPlace.current;
    const at = open ?? bundle;
    if (at !== undefined && pushed.current === at) {
      pushed.current = undefined;
      onBack();
      return;
    }
    written.current = undefined;
    setSelection(NOTHING_SELECTED);
    setPhonePane('list');
    if (at !== undefined) move({ view }, 'replace');
  }, [onBack, move, pushed, written]);
  // A thread opens in its bundle's place in the reader. On a phone that pushes the address, so Back
  // returns to the bundle, and a step to the next thread takes the place of the one open. Otherwise
  // the selection writes it, as a conversation's does.
  const openThread = useCallback(
    (id: ConversationId) => {
      if (bundleOpen === undefined) return;
      setThreadIn({ bundle: bundleOpen, open: id });
      if (!isPhoneNow.current) return;
      const { view, open } = latestPlace.current;
      written.current = id;
      if (open === undefined || pushed.current === open) pushed.current = id;
      move({ view, bundle: bundleOpen, open: id }, open === undefined ? 'push' : 'replace');
    },
    [bundleOpen, move, pushed, written],
  );
  const closeThread = useCallback(() => {
    const { bundle, open } = latestPlace.current;
    if (open !== undefined && pushed.current === open) {
      // The bundle was pushed too when the list opened it, so Back from it returns to the list.
      pushed.current = bundle;
      onBack();
      return;
    }
    setThreadIn(undefined);
  }, [onBack, pushed]);
  // A demo visitor's Mailroom keeps its accounts, erases itself, and says so.
  const isVisitor = useQuery(thisDeviceQuery).data?.visitor === true;
  const accountsCommands = useMemo(
    () =>
      accountCommands({
        accounts,
        keeps: isVisitor,
        add: () => openPage({ as: 'add' }),
        edit: (account) => openPage({ as: 'edit', account: account.id }),
        remove: setRemoving,
        signIn: (account) => openPage({ as: 'edit', account: account.id, isSigningIn: true }),
        erase: () => setErasing(true),
      }),
    [accounts, isVisitor, openPage],
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
  const openSettings = useCallback(
    (at?: SettingsAt) => openPage(at ? { as: 'settings', at } : { as: 'settings' }),
    [openPage],
  );
  // Only the operator has Members, in Settings.
  const isOperator = useQuery(operatorQuery).data === true;
  const openMembers = useMemo(
    () => (isOperator ? () => openSettings('members') : undefined),
    [isOperator, openSettings],
  );
  // A removed account's page closes, and so does a view of its folders.
  const removed = (account: Account) => {
    if (page?.as === 'edit' && page.account === account.id) closePage();
    if (view.in === 'folder' && view.folder.account === account.id) onViewChange({ in: 'inbox' });
  };
  // The list's order, read only by a pick that adds to the selection or extends it.
  const order = useRef<Listed<ListItem>>([]);
  useLayoutEffect(() => {
    order.current = conversations ?? [];
  }, [conversations]);
  const pick = useCallback(
    (id: ConversationId, by: SelectBy) => {
      setPage(undefined);
      setOpening(undefined);
      // Picking a bundle's row again shows the bundle, not the thread open in it.
      setThreadIn(undefined);
      setSelection((current) => select(current, id, by, by === 'only' ? [] : idsIn(order.current)));
      if (by !== 'only') return;
      setPhonePane('reader');
      openedByMember(id);
      const { view, bundle, open } = latestPlace.current;
      if (isPhoneNow.current && (bundle ?? open) !== id) {
        written.current = id;
        pushed.current = id;
        move(bundlePartsOf(id) ? { view, bundle: id } : { view, open: id }, 'push');
      }
    },
    [move, pushed, written, openedByMember],
  );
  const startPicking = useCallback((id: ConversationId) => {
    setPicking(true);
    setSelection({ ids: [id], anchor: id });
  }, []);
  // A finger tapping a row's avatar starts picking with it, or adds it or lets it go while picking.
  const pickRow = useCallback(
    (id: ConversationId) => (isPicking ? pick(id, 'toggle') : startPicking(id)),
    [isPicking, pick, startPicking],
  );
  // A swipe archives the row it moved, which leaves any selection that held it.
  const swipe = useCallback(
    (id: ConversationId) => {
      const { selection } = now.current;
      const left = selection.ids.includes(id) ? NOTHING_SELECTED : selection;
      const onRefused = backIfRefused(left);
      setSelection(left);
      triage({ do: 'archive' }, [id], { onRefused });
    },
    [triage, backIfRefused],
  );
  // A conversation about to be opened is asked for before the click lands.
  // A bundle's threads are asked for, and the reader that shows them loaded.
  const ahead = useCallback(
    (id: ConversationId, isPressed: boolean) => {
      if (bundlePartsOf(id) === undefined) return askAhead(queryClient, id, { body: isPressed });
      void queryClient.prefetchQuery(bundleQuery(id));
      void preloadBundleReader();
    },
    [queryClient],
  );
  // The list's row shows at once while the rest of the conversation is on its way, and stays
  // while the conversation leaves the list. A thread's is its bundle's.
  const shownRowOf = useCallback(
    (id: ConversationId) => {
      const row =
        rowOf(id) ??
        (vacating?.row.id === id ? vacating.row : undefined) ??
        inBundle.threads?.[inBundle.places.get(id) ?? -1];
      return row && !isBundle(row) ? row : undefined;
    },
    [rowOf, vacating, inBundle.threads, inBundle.places],
  );
  const stopPicking = () => {
    setPicking(false);
    setSelection(NOTHING_SELECTED);
  };
  // A thread open stands for the selection, so what acts on it acts on the thread.
  const pickedRows = useMemo(() => {
    if (threadRow !== undefined) return [threadRow];
    const rows = selection.ids
      .flatMap((id) => rowOf(id) ?? [])
      .toSorted((a, b) => (places.get(a.id) ?? 0) - (places.get(b.id) ?? 0));
    return vacating && selection.ids.includes(vacating.row.id) && !rows.includes(vacating.row)
      ? [...rows, vacating.row]
      : rows;
  }, [rowOf, places, selection.ids, vacating, threadRow]);
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
                : triageShown(action, thread ?? selected),
        });
  const selectionActions = (place: 'bar' | 'island') => (
    <TriageActions commands={selectedCommands} isCompact={place === 'island'} />
  );
  const outbox = useOutboxCommands();

  // Send sends what the open composer holds, once it's saved, and Undo brings the composer back as
  // it was, under its conversation if that's still the one open.
  const send = useSend();
  const sender = useRef<Sender['current']>(undefined);
  const [isSendable, setSendable] = useState(false);
  const shownNow = useRef(opened);
  useLayoutEffect(() => {
    shownNow.current = opened;
  });
  // A reply is on its way at the end of its conversation in the frame its composer closes, as is a
  // draft opened in its own, and leaves it again if the Mailroom refuses it or Undo takes it back. A
  // new message has no conversation until the Outbox names one.
  const sendWritten = (draft: MessageRef, at: string | undefined, writing: Writing) => {
    const from = { conversation: opened, isDocked: compose !== undefined && isDocked(compose) };
    // A draft opened from its conversation gives way to the next conversation, as one archived
    // does, when its send leaves nothing to show: a draft alone there, or a Drafts list the
    // conversation leaves.
    // The draft sent is the one opened, under whatever ref its last save gave it.
    if (compose?.as === 'draft' && compose.draft.conversation === opened) {
      const edited = compose.draft;
      const others = compose.conversation.filter(
        (message) => message.flags.draft && !sameRef(message, edited),
      );
      const isLeft =
        !from.isDocked || (isDraftsView(view, folders) && leavesDrafts(leaving.all, others));
      if (isLeft) giveWay(edited.conversation);
    }
    const pressedAt = Date.now();
    leaving.pressed(draft, {
      in: from.isDocked
        ? from.conversation
        : compose?.as === 'draft'
          ? compose.draft.conversation
          : undefined,
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
  // With no network nothing can be sent, and writing offline is out of scope, so Send and Send
  // later wait, and the composer says why.
  const writingCommands = useSendCommands(compose !== undefined, {
    onSend: (at) => sender.current?.(at),
    isEnabled: isSendable && reach === 'online',
    shortcut: 'Mod+Enter',
  });

  // The registry: every command the workbench can run now, gathered from each feature, which binds
  // their keys and feeds the palette and the shortcut sheet.
  const anchor = placeOf(selection.anchor);
  const stepTo = (at: number) => {
    const row = conversations?.[at];
    return row && (() => pick(row.id, 'only'));
  };
  // While a thread is open, the moves step through its bundle's threads instead.
  const stepToThread = (at: number) => {
    const row = inBundle.threads?.[at];
    return row && (() => openThread(row.id));
  };
  // In the dark theme, light paper for the conversation open, which a search may have left the list.
  // It reads the conversation as the reader fetched it, and never asks itself, so a held key that
  // passes rows asks for nothing the reader wouldn't.
  const isDark = useDarkTheme();
  const reading = isDark ? opened : undefined;
  const { data: read } = useQuery({ ...conversationQuery(reading ?? ''), enabled: false });
  const isReplyOnItsWay = useIsReplyOnItsWay();

  // The registry is made anew each render, as the selection moves, but its commands keep their
  // identity while they look the same, so what draws them and the palette render only on a change.
  // A new message fills the reader, over the conversation open behind it, so neither keys nor the
  // palette act on that conversation or move the list from under it. Keys typed straight after
  // New message, before its fields are drawn, then do nothing. A reply on its way to its editor
  // counts as the composer too, while its conversation stays in view with its place in the list.
  const isOverReader = compose !== undefined && (isPhone || !isDocked(compose));
  const isBehindComposer = isOverReader || isReplyOnItsWay;
  const isInView = opened !== undefined && !isMany && !isOverReader;
  const isOpenInView = isInView && !isBehindComposer;
  // A send on its way says where it stands on its line in its conversation while that's on screen,
  // and in a toast while the member is elsewhere.
  const shown =
    (!isPhone || phonePane === 'reader') && page === undefined && isInView ? opened : undefined;
  useLeavingToasts(leaving.all, shown);
  // What GitHub shows of what's open: the thread, or the bundle's repository.
  const openRow = threadRow ?? (selected === undefined ? undefined : rowOf(selected));
  const gitHubAddress =
    openRow === undefined || isMany
      ? undefined
      : isBundle(openRow)
        ? repositoryAddressOf(openRow.repository)
        : openRow.github && threadAddressOf(openRow.github);

  // A bundle gone from the server, as one emptied on another device, closes as a conversation gone
  // from it does.
  const isBundleGone =
    bundleOpen !== undefined &&
    !inBundle.isPending &&
    !inBundle.isError &&
    inBundle.bundle === undefined;
  useEffect(() => {
    if (!isBundleGone) return;
    setSelection(NOTHING_SELECTED);
    setPhonePane('list');
  }, [isBundleGone]);
  // A bundle open with no thread lies on the reader's sheet, its threads in place of messages, with
  // its row's actions where a conversation's are. A thread open in it names it above, as the way back.
  const bundleRow = bundleOpen === undefined ? undefined : rowOf(bundleOpen);
  const repository =
    inBundle.bundle?.repository ?? (bundleRow && isBundle(bundleRow) ? bundleRow.repository : '');
  const bundleAccount = bundleOpen && bundlePartsOf(bundleOpen)?.account;
  const bundleInbox = folders.find(
    (folder) => folder.account === bundleAccount && folder.role === 'inbox',
  );
  const bundleSheet: ReaderSheet | undefined =
    bundleOpen === undefined || thread !== undefined
      ? undefined
      : {
          id: bundleOpen,
          label: 'Repository',
          content: (scroller) =>
            inBundle.bundle && inBundle.threads ? (
              <Suspense fallback={<BundleSkeleton repository={repository} />}>
                <BundleReader
                  bundle={inBundle.bundle}
                  threads={inBundle.threads}
                  account={accounts.find(({ id }) => id === bundleAccount)}
                  folder={bundleInbox ? folderName(bundleInbox) : 'Inbox'}
                  scroller={scroller}
                  onOpen={openThread}
                  onShown={inBundle.show}
                  from={
                    cameFrom?.bundle === bundleOpen ? inBundle.places.get(cameFrom.open) : undefined
                  }
                />
              </Suspense>
            ) : inBundle.isError ? (
              <ConversationUnopened
                subject={repository}
                isOffline={reach !== 'online'}
                onTryAgain={inBundle.refetch}
              />
            ) : (
              <BundleSkeleton repository={repository || undefined} />
            ),
          bar: isPhone ? undefined : (
            <>
              <TriageActions commands={selectedCommands} />
              <ReaderPlace at={placeOf(bundleOpen).at + 1} of={conversations?.length ?? 0} />
            </>
          ),
          top: isPhone ? <TriageActions commands={selectedCommands} part="marking" /> : undefined,
          island: isPhone ? (
            <TriageActions commands={selectedCommands} part="filing" isArchiveMain />
          ) : undefined,
        };
  const backToBundle =
    bundleOpen !== undefined && thread !== undefined && repository !== ''
      ? {
          label: repository,
          short: repository.slice(repository.indexOf('/') + 1),
          go: closeThread,
        }
      : undefined;
  const unsubscribe = useUnsubscribeCommand(isOpenInView ? opened : undefined);
  const commands = useSteadyCommands([
    ...(isBehindComposer ? [] : selectedCommands),
    ...workbenchCommands({
      next: isOverReader
        ? undefined
        : thread !== undefined
          ? stepToThread(threadAt + 1)
          : stepTo(anchor.after),
      previous: isOverReader
        ? undefined
        : thread !== undefined
          ? threadAt > 0
            ? stepToThread(threadAt - 1)
            : undefined
          : anchor.at > 0
            ? stepTo(anchor.at - 1)
            : undefined,
      back: page
        ? closePage
        : composing.compose
          ? closeComposer
          : thread !== undefined
            ? closeThread
            : isPhone
              ? phonePane === 'list'
                ? undefined
                : phonePane === 'reader'
                  ? backToList
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
      openSettings: () => openSettings(),
      showShortcuts: () => setSheetOpen(true),
    }),
    ...composerCommands({
      write,
      reply: isOpenInView ? (all) => void composing.reply(all) : undefined,
    }),
    gitHubCommand(isBehindComposer ? undefined : gitHubAddress),
    sourceCommand(
      isOpenInView
        ? () =>
            void queryClient
              .ensureQueryData(conversationQuery(opened))
              .then((conversation) => setSource(newestOf(conversation)))
        : undefined,
    ),
    lightPaperCommand(reading === undefined ? undefined : read, accounts, selves, (choice) =>
      setLightPaper(queryClient, choice),
    ),
    unsubscribe,
    ...viewCommands(accounts, folders, openView),
    ...outbox.commands,
    ...folderEditing.commands,
    ...accountsCommands,
    ...memberCommands(openMembers),
    ...writingCommands,
    ...extraCommands(openSettings),
  ]);
  useCommandKeys(commands);
  // Whether what the sidebar shows is on its way: before the page has caught up with its Mailroom,
  // and while it checks an account.
  const isChecking = !isCaughtUp || accounts.some(({ status }) => status === 'syncing');
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
        <Suspense
          fallback={
            <ComposerSkeleton
              isNew={!isDocked(compose)}
              isSheet={isPhone}
              onClose={closeComposer}
            />
          }
        >
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
                search={isFieldInSidebar ? SIDEBAR_SEARCH_FIELD : undefined}
                settings={SETTINGS_GEAR}
                compose={isPhone ? undefined : NEW_MESSAGE}
                note={isVisitor ? VISITORS_NOTE : undefined}
                isBusy={isChecking}
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
                offline={reach === 'online' ? undefined : OFFLINE[reach]}
                scope={scope}
                below={
                  <>
                    {!isFieldInSidebar && SEARCH_FIELD}
                    {view.in === 'search' && (
                      <SearchScope
                        isFullText={view.fullText === true}
                        isSearching={isFetching}
                        isLimited={(conversations?.length ?? 0) >= MATCHES_LISTED}
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
                listKey={hashKey([view])}
                conversations={isFilling && conversations?.length === 0 ? undefined : conversations}
                isUpdating={isFetching}
                marks={marks}
                stamps={mixesAccounts ? stamps : undefined}
                selves={selves}
                selection={selection}
                isPicking={isPicking}
                onSelect={pick}
                onLongPress={startPicking}
                onPick={pickRow}
                onSwipe={swipe}
                onAhead={ahead}
                picked={
                  <PickedActions count={selection.ids.length} onCancel={stopPicking}>
                    {selectionActions('island')}
                  </PickedActions>
                }
                onShown={onListShown}
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
                  selected={opened}
                  accounts={accounts}
                  folders={folders}
                  upcoming={
                    thread === undefined
                      ? neighbors(conversations, places, selected)
                      : idsIn([inBundle.threads?.[threadAt + 1], inBundle.threads?.[threadAt - 1]])
                  }
                  sheet={bundleSheet}
                  backTo={backToBundle}
                  onShown={readMark.onShown}
                  actions={readerActions}
                  place={readerPlace}
                  actionsFor={messageActions}
                  onMessageKey={runCommandKey}
                  writing={writing}
                  hiding={composing.hiding}
                  leaving={leaving.all}
                  onOpenDraft={composing.openDraft}
                  rowOf={shownRowOf}
                  choose={
                    view.in === 'outbox'
                      ? 'Choosing a send opens its conversation here.'
                      : undefined
                  }
                  page={
                    page?.as === 'settings' ? (
                      settings(page.at)
                    ) : page ? (
                      <AccountPage
                        page={page}
                        accounts={accounts}
                        isVisitor={isVisitor}
                        onClose={closePage}
                        onRemove={setRemoving}
                        onErase={() => setErasing(true)}
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
      {isErasing && (
        <Suspense>
          <EraseQuestion
            accounts={accounts}
            waiting={(outgoing ?? []).filter(({ state }) => state === 'waiting').length}
            onClose={() => setErasing(false)}
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
 * Whether a view opens at its newest conversation: on a desktop, where the reader lies beside the
 * list, so the reader always belongs to the list. The Outbox lists sends, not conversations, and a
 * phone shows the list alone.
 */
const opensNewest = (view: View, isPhone: boolean) => !isPhone && view.in !== 'outbox';

/** A selection of the one conversation an address opens, or of none. */
const openOnly = (open: ConversationId | undefined): Selection =>
  open === undefined ? NOTHING_SELECTED : { ids: [open], anchor: open };

/**
 * The open conversation and the place, kept together. A change of view pushes the place, so Back
 * returns to it, except while a search is typed, which replaces it at each key. The selection
 * replaces it, so moving by key adds no history. A place the workbench didn't move to arrives from
 * outside, as a load, a link, Back and Forward bring one, and the workbench follows it. A place
 * whose conversation has gone opens its view with nothing selected, or its bundle with no thread.
 */
function useAddress({
  place,
  onPlaceChange,
  bundle,
  open,
  isMany,
  arrive,
  close,
}: {
  place: Place;
  onPlaceChange: (place: Place, history: 'push' | 'replace') => void;
  /** The bundle selected, if one is. */
  bundle: BundleId | undefined;
  /** The one conversation open, selected or a thread of the bundle selected, if one is. */
  open: ConversationId | undefined;
  /** Whether several are, which the address leaves out. */
  isMany: boolean;
  /** Follows a place that arrived from outside. */
  arrive: (place: Place) => void;
  /** Closes the conversation open, as one gone from the server leaves nothing open. */
  close: () => void;
}) {
  const { view } = place;
  // The place this workbench last moved to, so one it didn't is known to have arrived.
  const moved = useRef(place);
  // What the selection last wrote, and what was last pushed, so the selection doesn't write back
  // a place it already holds.
  const written = useRef(place.open ?? place.bundle);
  const pushed = useRef<ConversationId>(undefined);
  // The conversation a place opened from outside, until the member moves on. It's looked up, since
  // it may have gone since the address was written.
  const [arrived, setArrived] = useState(place.open);
  const latest = useRef({ view, bundle, open, arrive, close });
  useLayoutEffect(() => {
    latest.current = { view, bundle, open, arrive, close };
  });
  const move = useCallback(
    (next: Place, history: 'push' | 'replace') => {
      moved.current = next;
      onPlaceChange(next, history);
    },
    [onPlaceChange],
  );

  useEffect(() => {
    if (place === moved.current) return;
    moved.current = place;
    written.current = place.open ?? place.bundle;
    setArrived(place.open);
    latest.current.arrive(place);
  }, [place]);

  // Only a change of selection moves the place, not the place moving under a selection that hasn't
  // followed it yet.
  const at = open ?? bundle;
  useEffect(() => {
    if (isMany || at === written.current) return;
    written.current = at;
    setArrived(undefined);
    const { view, bundle, open } = latest.current;
    move(placeIn(view, bundle, open), 'replace');
  }, [isMany, at, move]);

  const { data: shown } = useQuery({
    ...conversationQuery(arrived ?? ''),
    enabled: arrived !== undefined,
  });
  useEffect(() => {
    if (arrived === undefined || shown === undefined || shown.length > 0) return;
    setArrived(undefined);
    // The member may have moved on already, as archiving it does.
    const { view, bundle, open } = latest.current;
    if (open !== arrived) return;
    written.current = bundle;
    latest.current.close();
    move(placeIn(view, bundle, undefined), 'replace');
  }, [arrived, shown, move]);

  // The view changes under the open conversation, as a search typed or a folder renamed changes it.
  const onViewChange = useCallback(
    (next: View) => {
      const { view, bundle, open } = latest.current;
      move(placeIn(next, bundle, open), historyFrom(view));
    },
    [move],
  );
  // The member chooses a view, which opens with nothing open, until its newest fills it.
  const chooseView = useCallback(
    (next: View) => {
      written.current = undefined;
      setArrived(undefined);
      move({ view: next }, historyFrom(latest.current.view));
    },
    [move],
  );
  return { move, onViewChange, chooseView, written, pushed };
}

/** The place of a view, with the bundle and the conversation open in it, if any. */
const placeIn = (
  view: View,
  bundle: BundleId | undefined,
  open: ConversationId | undefined,
): Place => ({
  view,
  ...(bundle === undefined ? {} : { bundle }),
  ...(open === undefined ? {} : { open }),
});

/** A step to a new view is pushed, so Back returns, except from a search, which it takes the place of. */
const historyFrom = (view: View) => (view.in === 'search' ? 'replace' : 'push');

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
      void queryClient.prefetchQuery(conversationsQuery(searched));
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
  conversations: Listed<ListItem> | undefined,
  places: ReadonlyMap<ConversationId, number>,
  selected: ConversationId | undefined,
): ConversationId[] {
  if (!conversations) return [];
  const at = selected === undefined ? undefined : places.get(selected);
  if (selected !== undefined && at === undefined) return [];
  const near =
    at === undefined ? conversations.slice(0, 2) : [conversations[at + 1], conversations[at - 1]];
  // A bundle is no conversation to prepare.
  return idsIn(near).filter((id) => bundlePartsOf(id) === undefined);
}

/** The ids of a list's fetched rows, in its order. */
function idsIn(rows: Listed<ListItem>): ConversationId[] {
  return rows.flatMap((row) => (row ? [row.id] : []));
}

const NO_PLACES: ReadonlyMap<ConversationId, number> = new Map();

/** How the public demo names itself, under a visitor's accounts. */
const VISITORS_NOTE = 'A sample mailbox, yours for a day.';

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
