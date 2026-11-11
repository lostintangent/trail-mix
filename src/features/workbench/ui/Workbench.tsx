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
  marksOf,
  type Account,
  type AccountId,
  type ConversationId,
  type ConversationSummary,
  type Folder,
  type Message,
  type MessageRef,
  type Place,
  type View,
} from '../../mail/core/index.ts';
import {
  conversationQuery,
  conversationsQuery,
  MATCHES_LISTED,
  outboxQuery,
} from '../../mailroom/client/index.ts';
import {
  OutboxList,
  SendActions,
  sendCommands,
  type LeavingSends,
  useOutboxCommands,
  useSend,
} from '../../outbox/index.ts';
import { ListPane } from './ListPane.tsx';
import { PanelEdge } from './PanelEdge.tsx';
import { PANELS } from './panels.ts';
import { useReadMark } from './useReadMark.ts';
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
  placesOf,
  type Listed,
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
import {
  Composer,
  composerCommands,
  ComposerSkeleton,
  isDocked,
  type Sender,
  type Writing,
} from '../../composer/ui/index.ts';
import { newestOf, useComposing } from './useComposing.ts';

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
  EraseQuestion,
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
  place,
  onPlaceChange,
  onBack,
  accounts,
  folders,
  counts,
  conversations,
  isFetching,
  onListShown,
  sidebarFooter,
  extraCommands = NO_COMMANDS,
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
  conversations: Listed<ConversationSummary> | undefined;
  /** Whether the view's rows are on their way. */
  isFetching: boolean;
  /** Says which rows the list shows, so the pages they lie on are fetched. */
  onListShown: (first: number, last: number, selected: number) => void;
  sidebarFooter: ReactNode;
  /** Commands from outside the workbench, such as the theme's, for the registry. */
  extraCommands?: readonly Command[];
  /** The sends this device follows, which the counts and the Drafts list read too. */
  leaving: LeavingSends;
}) {
  const queryClient = useQueryClient();
  const { view } = place;
  // The conversation the address opens is the one selected, from the first render.
  const [selection, setSelection] = useState<Selection>(() => openOnly(place.open));
  const [isPicking, setPicking] = useState(false);
  // Picking ends with the last conversation picked.
  useEffect(() => {
    if (isPicking && selection.ids.length === 0) setPicking(false);
  }, [isPicking, selection.ids.length]);
  // One conversation selected is the one open in the reader. Several wait for an action together.
  const selected = selection.ids.length === 1 ? selection.ids[0] : undefined;
  const isMany = selection.ids.length > 1;
  const stamps = useMemo(() => new Map(accounts.map(({ id, stamp }) => [id, stamp])), [accounts]);
  // A row's avatar is its newest sender other than the member, by any of their addresses.
  const selves = useMemo(
    () => new Set(accounts.map(({ address }) => address.toLowerCase())),
    [accounts],
  );
  // Stamps mark rows only in a list that mixes accounts.
  const mixesAccounts = view.in !== 'folder' && accounts.length > 1;
  // On a phone, an address with a conversation opens on the reader, with no slide to it.
  const [phonePane, setPhonePane] = useState<Pane>(() => (place.open ? 'reader' : 'list'));
  const [sidebar, setSidebar] = usePanel(PANELS.sidebar);
  const [list, setList] = usePanel(PANELS.list);
  const [isResizing, setIsResizing] = useState(false);
  const isPhone = useMediaQuery(media.phone);
  // The view that opens at its newest conversation once its list is known, as one does that arrives
  // naming none.
  const [opening, setOpening] = useState(() =>
    place.open === undefined && opensNewest(view, isPhone) ? view : undefined,
  );
  const sidebarId = useId();
  const listId = useId();
  const { title, unread, scope } = describeView(view, accounts, folders, counts);
  const { move, onViewChange, chooseView, written, pushed } = useAddress({
    place,
    onPlaceChange,
    selected,
    isMany,
    // The conversation a place names is the one selected, and a view that names none opens at its
    // newest.
    arrive: ({ view, open }) => {
      setSelection(openOnly(open));
      setPhonePane(open ? 'reader' : 'list');
      setOpening(open === undefined && opensNewest(view, isPhone) ? view : undefined);
    },
    close: () => {
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
  const composing = useComposing(selected, leaving.drafts);
  const { compose } = composing;
  // A new message is from the account the view holds, or else the first.
  const writeFrom = scope ?? accounts[0];
  const closeComposer = composing.close;
  // An account's page, or the Members page, lies where a new message's composer would, so writing
  // one closes it.
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
  const [vacating, setVacating] = useState<{ row: ConversationSummary; at: number }>();
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
  const triageShown = (action: Action, id: ConversationId) => {
    if (rowChange(action, view) === 'gone') {
      const at = places.get(id) ?? -1;
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
      const at = id === undefined ? -1 : (places.get(id) ?? -1);
      return at < 0 && vacating !== undefined && vacating.row.id === id
        ? { at: vacating.at, after: vacating.at }
        : { at, after: at + 1 };
    },
    [places, vacating],
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
    if (rowOf(id)?.unread) {
      triage({ do: 'read' }, [id], { quietly: true });
    }
  };
  const readMark = useReadMark({ selected, markRead });
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
      <ReaderPlace at={placeOf(shown).at + 1} of={conversations?.length ?? 0} />
    ),
    [placeOf, conversations],
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
    setSelection({ ids: [newest.id], anchor: newest.id });
    openedByView(newest.id);
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
  const closePage = useCallback(() => {
    setPage(undefined);
    if (isPhone) setPhonePane('list');
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
  const backToList = useCallback(() => {
    const { view, open } = latestPlace.current;
    if (open !== undefined && pushed.current === open) {
      pushed.current = undefined;
      onBack();
      return;
    }
    written.current = undefined;
    setSelection(NOTHING_SELECTED);
    setPhonePane('list');
    if (open !== undefined) move({ view }, 'replace');
  }, [onBack, move, pushed, written]);
  const accountsCommands = useMemo(
    () =>
      accountCommands({
        accounts,
        add: () => openPage({ as: 'add' }),
        edit: (account) => openPage({ as: 'edit', account: account.id }),
        remove: setRemoving,
        signIn: (account) => openPage({ as: 'edit', account: account.id, isSigningIn: true }),
        erase: () => setErasing(true),
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
  // The list's order, read only by a pick that adds to the selection or extends it.
  const order = useRef<Listed<ConversationSummary>>([]);
  useLayoutEffect(() => {
    order.current = conversations ?? [];
  }, [conversations]);
  // On a phone, opening a conversation pushes the address, so Back slides from it to its list.
  const isPhoneNow = useRef(isPhone);
  useLayoutEffect(() => {
    isPhoneNow.current = isPhone;
  });
  const pick = useCallback(
    (id: ConversationId, by: SelectBy) => {
      setPage(undefined);
      setSelection((current) => select(current, id, by, by === 'only' ? [] : idsIn(order.current)));
      if (by !== 'only') return;
      setPhonePane('reader');
      openedByMember(id);
      const { view, open } = latestPlace.current;
      if (isPhoneNow.current && open !== id) {
        written.current = id;
        pushed.current = id;
        move({ view, open: id }, 'push');
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
  // The list's subject shows at once while the rest of the conversation is on its way, and stays
  // while the conversation leaves the list.
  const subjectOf = useCallback(
    (id: ConversationId) =>
      rowOf(id)?.subject ?? (vacating?.row.id === id ? vacating.row.subject : undefined),
    [rowOf, vacating],
  );
  const stopPicking = () => {
    setPicking(false);
    setSelection(NOTHING_SELECTED);
  };
  const pickedRows = useMemo(() => {
    const rows = selection.ids
      .flatMap((id) => rowOf(id) ?? [])
      .toSorted((a, b) => (places.get(a.id) ?? 0) - (places.get(b.id) ?? 0));
    return vacating && selection.ids.includes(vacating.row.id) && !rows.includes(vacating.row)
      ? [...rows, vacating.row]
      : rows;
  }, [rowOf, places, selection.ids, vacating]);
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
  // A reply is on its way at the end of its conversation in the frame its composer closes, as is a
  // draft opened in its own, and leaves it again if the Mailroom refuses it or Undo takes it back. A
  // new message has no conversation until the Outbox names one.
  const sendWritten = (draft: MessageRef, at: string | undefined, writing: Writing) => {
    const from = { conversation: selected, isDocked: compose !== undefined && isDocked(compose) };
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
  // A new message fills the reader, over the conversation open behind it, so neither keys nor the
  // palette act on that conversation or move the list from under it. Keys typed straight after
  // New message, before its fields are drawn, then do nothing.
  const isBehindComposer = compose !== undefined && (isPhone || !isDocked(compose));
  const isOpenInView = selected !== undefined && !isMany && !isBehindComposer;
  const commands = useSteadyCommands([
    ...(isBehindComposer ? [] : selectedCommands),
    ...workbenchCommands({
      next: isBehindComposer ? undefined : stepTo(anchor.after),
      previous: !isBehindComposer && anchor.at > 0 ? stepTo(anchor.at - 1) : undefined,
      back: page
        ? closePage
        : composing.compose
          ? closeComposer
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
      showShortcuts: () => setSheetOpen(true),
    }),
    ...composerCommands({
      write,
      reply: isOpenInView ? (all) => void composing.reply(all) : undefined,
    }),
    sourceCommand(
      isOpenInView
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
                conversations={conversations}
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
                    <Suspense>{selectionActions('island')}</Suspense>
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
                  upcoming={neighbors(conversations, places, selected)}
                  onShown={readMark.onShown}
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
 * whose conversation has gone opens its view with nothing selected.
 */
function useAddress({
  place,
  onPlaceChange,
  selected,
  isMany,
  arrive,
  close,
}: {
  place: Place;
  onPlaceChange: (place: Place, history: 'push' | 'replace') => void;
  /** The one conversation selected, if one is. */
  selected: ConversationId | undefined;
  /** Whether several are, which the address leaves out. */
  isMany: boolean;
  /** Follows a place that arrived from outside. */
  arrive: (place: Place) => void;
  /** Selects nothing, as a conversation gone from the server leaves nothing open. */
  close: () => void;
}) {
  const { view, open } = place;
  // The place this workbench last moved to, so one it didn't is known to have arrived.
  const moved = useRef(place);
  // What the selection last wrote, and what was last pushed, so the selection doesn't write back
  // a place it already holds.
  const written = useRef(open);
  const pushed = useRef<ConversationId>(undefined);
  // The conversation a place opened from outside, until the member moves on. It's looked up, since
  // it may have gone since the address was written.
  const [arrived, setArrived] = useState(open);
  const latest = useRef({ view, selected, arrive, close });
  useLayoutEffect(() => {
    latest.current = { view, selected, arrive, close };
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
    written.current = place.open;
    setArrived(place.open);
    latest.current.arrive(place);
  }, [place]);

  // Only a change of selection moves the place, not the place moving under a selection that hasn't
  // followed it yet.
  useEffect(() => {
    if (isMany || selected === written.current) return;
    written.current = selected;
    setArrived(undefined);
    const { view } = latest.current;
    move(selected === undefined ? { view } : { view, open: selected }, 'replace');
  }, [isMany, selected, move]);

  const { data: shown } = useQuery({
    ...conversationQuery(arrived ?? ''),
    enabled: arrived !== undefined,
  });
  useEffect(() => {
    if (arrived === undefined || shown === undefined || shown.length > 0) return;
    setArrived(undefined);
    // The member may have moved on already, as archiving it does.
    if (latest.current.selected !== arrived) return;
    written.current = undefined;
    latest.current.close();
    move({ view: latest.current.view }, 'replace');
  }, [arrived, shown, move]);

  // The view changes under the open conversation, as a search typed or a folder renamed changes it.
  const onViewChange = useCallback(
    (next: View) => {
      const { view, selected } = latest.current;
      move(
        selected === undefined ? { view: next } : { view: next, open: selected },
        historyFrom(view),
      );
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
  conversations: Listed<ConversationSummary> | undefined,
  places: ReadonlyMap<ConversationId, number>,
  selected: ConversationId | undefined,
): ConversationId[] {
  if (!conversations) return [];
  if (selected === undefined) return idsIn(conversations.slice(0, 2));
  const at = places.get(selected);
  if (at === undefined) return [];
  return idsIn([conversations[at + 1], conversations[at - 1]]);
}

/** The ids of a list's fetched conversations, in its order. */
function idsIn(rows: Listed<ConversationSummary>): ConversationId[] {
  return rows.flatMap((row) => (row ? [row.id] : []));
}

const NO_PLACES: ReadonlyMap<ConversationId, number> = new Map();

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
