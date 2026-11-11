import { EmptyState } from '@astryxdesign/core/EmptyState';
import { Icon } from '@astryxdesign/core/Icon';
import { IconButton } from '@astryxdesign/core/IconButton';
import { borderVars, colorVars, spacingVars } from '@astryxdesign/core/theme/tokens.stylex';
import * as stylex from '@stylexjs/stylex';
import { useQuery } from '@tanstack/react-query';
import { ChevronLeft, MailOpen } from 'lucide-react';
import {
  memo,
  Suspense,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useDeferredValue,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { media, tm } from '../../../app/theme/tokens.stylex.ts';
import { afterPaint } from '../../../shared/afterPaint.ts';
import type { Command } from '../../commands/index.ts';
import type {
  Account,
  ConversationId,
  Folder,
  Message,
  MessageRef,
} from '../../mail/core/index.ts';
import { conversationQuery } from '../../mailroom/client/index.ts';
import { preloadTriageMenus } from '../../conversations/index.ts';
import { preloadComposer } from '../../composer/ui/index.ts';
import { isAwaitingCopy, leavingIn, preloadSendActions, type Leaving } from '../../outbox/index.ts';
import { useReach } from '../../offline/index.ts';
import {
  ConversationUnopened,
  preloadReader,
  Reader,
  ReaderSkeleton,
  REST_MS,
} from '../../reader/index.ts';
import { PhoneIsland } from './PhoneIsland.tsx';

/** The conversation the reader shows, with its messages and the account they belong to. */
export type Reading = { id: ConversationId; conversation: Message[]; account: Account };

/** Where a conversation's actions are drawn: a desktop's bar, or a phone's top bar and island. */
export type ActionsPlace = 'bar' | 'top' | 'island';

/**
 * The reader's sheet, where an open conversation lies. On a phone it fills the screen, with a way
 * back to the list at its top. The reader itself loads soon after the list shows a conversation to
 * open, while the browser is idle, ready for the click.
 */
export function ReaderPane({
  selected,
  accounts,
  folders,
  upcoming,
  onShown,
  actions,
  place,
  actionsFor,
  onMessageKey,
  writing,
  hidden,
  leaving,
  onOpenDraft,
  page,
  subjectOf,
  choose = 'Choose one from the list to read it here.',
  onBack,
}: {
  selected: ConversationId | undefined;
  accounts: readonly Account[];
  /** The member's folders, to name the one the conversation lies in. */
  folders: readonly Folder[];
  /** The conversations the member may open next, which the reader prepares while idle. */
  upcoming: ConversationId[];
  /**
   * Called each time the reader starts showing a conversation, which is what opening it means. A
   * conversation the selection passes on its way elsewhere is never shown.
   */
  onShown?: (conversation: ConversationId) => void;
  /**
   * What can be done to the conversation shown: in a bar above it on a desktop where the reader
   * stands alone, and on a phone split between the bar at the top of the screen and the island at
   * the bottom. Where the list shows, its header has them, and the bar holds only the place.
   */
  actions?: (reading: Reading, place: ActionsPlace) => ReactNode;
  /** Where the conversation shown sits in the list, at the end of a desktop's bar. */
  place?: (shown: ConversationId) => ReactNode;
  /** What can be done with one of its messages, as the reader's own. The same function each render. */
  actionsFor?: (message: Message) => readonly Command[];
  /** Keys pressed inside a message, which the window never hears. The same function each render. */
  onMessageKey?: (event: KeyboardEvent) => void;
  /**
   * The composer, while the member writes: docked under the conversation it answers, or filling
   * the sheet for a message of its own.
   */
  writing?: { composer: ReactNode; place: 'docked' | 'filled' | 'over' };
  /** Drafts the reader leaves out, such as the one being written. */
  hidden?: readonly MessageRef[];
  /** The sends this device follows, each at the end of its conversation while it is on its way. */
  leaving?: readonly Leaving[];
  /** Opens a draft in the conversation to go on writing it. */
  onOpenDraft?: (draft: Message, conversation: Message[]) => void;
  /** A page that lies on the sheet in place of a conversation, such as an account's. */
  page?: ReactNode;
  /** A conversation's subject as the list has it, to show at once while the rest is on its way. */
  subjectOf?: (id: ConversationId) => string | undefined;
  /** What the empty reader asks the member to choose, in the words of the list beside it. */
  choose?: string;
  onBack: () => void;
}) {
  const { shown, isPassing } = useRestingSelection(selected);
  const isOffline = useReach() !== 'online';
  const {
    data: conversation,
    isPending,
    isError,
    refetch,
  } = useQuery({
    ...conversationQuery(shown ?? ''),
    enabled: shown !== undefined,
    // A reply gone from the Outbox waits for its copy, which a lost hint can't keep from showing.
    refetchInterval: ({ state: { data } }) =>
      shown && data && leavingIn(leaving ?? [], shown, data).some(isAwaitingCopy)
        ? AWAITING_COPY_MS
        : false,
  });
  const account = accounts.find(({ id }) => id === conversation?.[0]?.account);
  const reading = useMemo<Reading | undefined>(
    () =>
      shown && conversation?.length && account ? { id: shown, conversation, account } : undefined,
    [shown, conversation, account],
  );
  // Made once for each conversation shown, so the moves of a held key pass them by.
  const bar = useMemo(() => reading && actions?.(reading, 'bar'), [reading, actions]);
  const top = useMemo(() => reading && actions?.(reading, 'top'), [reading, actions]);
  const island = useMemo(() => reading && actions?.(reading, 'island'), [reading, actions]);
  const isShowing = reading !== undefined;
  // On its way: asked for, and not here yet. Its skeleton stands where it will lie.
  const isOpening =
    shown !== undefined && !isShowing && (isPending || (conversation?.length ?? 0) > 0);
  // Asked for and refused, as with no network for one this device didn't keep. A selection never
  // shows the empty reader, so it says why under the subject instead.
  const isUnopened = shown !== undefined && !isShowing && !isOpening && isError;
  // Where it sits in the list is known before it arrives, so the bar stands still as it does.
  const placed = useMemo(
    () =>
      shown !== undefined && (isShowing || isOpening || isUnopened) ? place?.(shown) : undefined,
    [shown, isShowing, isOpening, isUnopened, place],
  );
  const openDraft = useMemo(
    () => reading && onOpenDraft && ((draft: Message) => onOpenDraft(draft, reading.conversation)),
    [reading, onOpenDraft],
  );
  const isDocked = writing?.place === 'docked';
  // A page lies on the sheet as a new message's composer does, filling it.
  const isFilled = writing?.place === 'filled' || page !== undefined;
  const announce = useEffectEvent((id: ConversationId) => onShown?.(id));
  // A conversation counts as shown once a frame has drawn it, so what that sets off, its read mark,
  // waits for that frame instead of holding up the key or click that opened it.
  useEffect(() => {
    if (shown === undefined || !isShowing) return;
    let isStill = true;
    void afterPaint().then(() => isStill && announce(shown));
    return () => {
      isStill = false;
    };
  }, [shown, isShowing]);
  usePreloadedReader(upcoming.length > 0);
  usePreloadedComposer(isShowing ? shown : undefined);
  // Preparing what comes next is never urgent, so a change to it, as when the open conversation
  // leaves the list, doesn't make the open conversation render again in the change's own frame.
  const preparing = useDeferredValue(upcoming);

  return (
    <section aria-label="Reader" {...stylex.props(styles.sheet)}>
      <header {...stylex.props(styles.phoneHeader)}>
        <BackButton onClick={onBack} />
        {top && !writing && !page ? (
          <div role="toolbar" aria-label="Marks" {...stylex.props(styles.top)}>
            <Suspense>{top}</Suspense>
          </div>
        ) : null}
      </header>
      {page ? (
        <div {...stylex.props(styles.scroll)}>
          <Suspense>{page}</Suspense>
        </div>
      ) : isFilled ? (
        <div {...stylex.props(styles.scroll, styles.filled)}>
          <div {...stylex.props(styles.writing, styles.filled)}>{writing?.composer}</div>
        </div>
      ) : null}
      {/* A composer over everything lies outside the panes, wherever it is drawn. */}
      {writing?.place === 'over' && writing.composer}
      {(bar || placed) && !isFilled ? (
        <div
          role="toolbar"
          aria-label={bar ? 'Conversation' : 'Place'}
          {...stylex.props(styles.bar)}
        >
          {bar && <Suspense>{bar}</Suspense>}
          {placed}
        </div>
      ) : null}
      {isFilled ? null : reading ? (
        <div {...stylex.props(styles.scroll, actions && styles.underBar)}>
          <Suspense fallback={<ReaderSkeleton subject={subjectOf?.(reading.id)} />}>
            <Reader
              conversation={reading.conversation}
              account={reading.account}
              folders={folders}
              actionsFor={actionsFor}
              upcoming={isPassing ? [] : preparing}
              onMessageKey={onMessageKey}
              hidden={hidden}
              leaving={leaving}
              onOpenDraft={openDraft}
              isPassing={isPassing}
            />
          </Suspense>
          {isDocked && <div {...stylex.props(styles.writing)}>{writing?.composer}</div>}
        </div>
      ) : isOpening ? (
        <div {...stylex.props(styles.scroll, actions && styles.underBar)}>
          <ReaderSkeleton subject={shown && subjectOf?.(shown)} />
        </div>
      ) : isUnopened ? (
        <div {...stylex.props(styles.scroll, actions && styles.underBar)}>
          <ConversationUnopened
            subject={subjectOf?.(shown)}
            isOffline={isOffline}
            onTryAgain={() => void refetch()}
          />
        </div>
      ) : (
        <div {...stylex.props(styles.empty)}>
          <EmptyState
            icon={<Icon icon={MailOpen} size="lg" color="secondary" />}
            title="No conversation open"
            description={choose}
          />
        </div>
      )}
      {island && !writing && !page ? (
        <PhoneIsland label="Conversation" spans>
          <Suspense>{island}</Suspense>
        </PhoneIsland>
      ) : null}
    </section>
  );
}

/**
 * The selection the reader shows, and whether the selection is passing it by. One made after a rest
 * shows at once. While the member moves quickly, as when holding a key, the reader waits until the
 * selection rests, so it does no work nobody would see, and the list keeps up.
 *
 * Only a move that doesn't rest passes the conversation shown by. The selection's own commit leaves
 * the reader as it was, so a move that rests turns it to the next conversation directly.
 *
 * A move is timed by the press that made it, not by when it was drawn, so on a slow phone a render
 * that runs long can't make quick presses look like rests.
 */
function useRestingSelection(selected: ConversationId | undefined) {
  const [shown, setShown] = useState(selected);
  const [isPassing, setPassing] = useState(false);
  const pressedAt = useLastPress();
  // When the selection last moved between conversations, the press the last move used, and what
  // it moved from.
  const movedAt = useRef(-Infinity);
  const usedPress = useRef(-Infinity);
  const movedFrom = useRef(selected);
  useLayoutEffect(() => {
    const isPressed = pressedAt.current > usedPress.current;
    const at = isPressed ? pressedAt.current : performance.now();
    usedPress.current = pressedAt.current;
    // Resting matters between conversations, which keys pass by. A move to none or from none, as
    // choosing a view and opening its newest make, shows at once, and only a move to a conversation
    // that a press or a step between conversations made starts a rest.
    const isBetween = movedFrom.current !== undefined && selected !== undefined;
    const hasRested = !isBetween || at - movedAt.current >= REST_MS;
    if (selected !== undefined && (isPressed || isBetween)) movedAt.current = at;
    movedFrom.current = selected;
    const show = () => {
      setShown(selected);
      setPassing(false);
    };
    if (hasRested) {
      show();
      return;
    }
    setPassing(true);
    const timer = setTimeout(show, REST_MS);
    return () => clearTimeout(timer);
  }, [selected, pressedAt]);
  return { shown, isPassing: isPassing && shown !== selected };
}

/** When the member last pressed a key or a pointer, as the event says, however late it ran. */
function useLastPress() {
  const pressedAt = useRef(-Infinity);
  useEffect(() => {
    const note = (event: Event) => {
      pressedAt.current = event.timeStamp;
    };
    window.addEventListener('keydown', note, { capture: true });
    window.addEventListener('pointerdown', note, { capture: true });
    return () => {
      window.removeEventListener('keydown', note, { capture: true });
      window.removeEventListener('pointerdown', note, { capture: true });
    };
  }, []);
  return pressedAt;
}

/** How often a conversation is fetched again while a reply that left it waits for its copy. */
const AWAITING_COPY_MS = 2_000;

/** How long after the list first shows something to open the reader starts loading. */
const PRELOAD_AFTER_MS = 1_000;

/** How long a conversation stays open before the composer loads for a reply. */
const PRELOAD_COMPOSER_AFTER_MS = 2_000;

/**
 * Once a conversation has stayed open a moment, the composer loads while the browser is idle,
 * ready for a reply. Its code is large, so it never loads while the member moves through the list.
 */
function usePreloadedComposer(shown: ConversationId | undefined) {
  useEffect(() => {
    if (shown === undefined) return;
    let idleId: number | undefined;
    const timer = setTimeout(() => {
      // Safari has no idle callback.
      const preload = () => void Promise.all([preloadComposer(), preloadSendActions()]);
      if ('requestIdleCallback' in window) idleId = requestIdleCallback(preload);
      else preload();
    }, PRELOAD_COMPOSER_AFTER_MS);
    return () => {
      clearTimeout(timer);
      if (idleId !== undefined) cancelIdleCallback(idleId);
    };
  }, [shown]);
}

function usePreloadedReader(isWanted: boolean) {
  useEffect(() => {
    if (!isWanted) return;
    const timer = setTimeout(() => {
      // Safari has no idle callback.
      const load = () => {
        void preloadReader();
        void preloadTriageMenus();
      };
      if ('requestIdleCallback' in window) requestIdleCallback(load);
      else load();
    }, PRELOAD_AFTER_MS);
    return () => clearTimeout(timer);
  }, [isWanted]);
}

const BACK_ICON = <Icon icon={ChevronLeft} />;

// The header with Back is a phone's, and hidden on wider screens, so it costs nothing as the
// reader changes.
const BackButton = memo(function BackButton({ onClick }: { onClick: () => void }) {
  return <IconButton label="Back" icon={BACK_ICON} variant="ghost" onClick={onClick} />;
});

const styles = stylex.create({
  sheet: {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    backgroundColor: {
      default: colorVars['--color-background-surface'],
      [media.phone]: 'transparent',
    },
    borderRadius: { default: tm.paneRadius, [media.phone]: 0 },
    boxShadow: { default: tm.sheetEdge, [media.phone]: 'none' },
    outline: {
      default: null,
      [media.forcedColors]: {
        default: `${borderVars['--border-width']} solid CanvasText`,
        [media.phone]: 'none',
      },
    },
  },
  // On a phone, back to the list on the left, and the conversation's marks on the right.
  phoneHeader: {
    display: { default: 'none', [media.phone]: 'flex' },
    alignItems: 'center',
    paddingTop: tm.safeTop,
    paddingInline: spacingVars['--spacing-2'],
  },
  top: {
    display: 'flex',
    alignItems: 'center',
    marginInlineStart: 'auto',
  },
  // On a desktop the conversation's actions sit in a bar along the top of its sheet.
  bar: {
    display: { default: 'flex', [media.phone]: 'none' },
    flexShrink: 0,
    alignItems: 'center',
    gap: spacingVars['--spacing-0-5'],
    paddingTop: spacingVars['--spacing-2'],
    paddingInline: spacingVars['--spacing-2'],
  },
  scroll: {
    flexGrow: 1,
    minHeight: 0,
    overflowY: 'auto',
    overscrollBehavior: 'contain',
    paddingTop: { default: spacingVars['--spacing-6'], [media.phone]: spacingVars['--spacing-1'] },
  },
  // Below a desktop's bar the subject needs less room above it, and on a phone the conversation
  // ends above the island: its height, its padding, and the gap below it. It also ends above a
  // toast, which rises over the island: a row of controls, its padding and airmail, and a gap. So a
  // reply just sent comes into view clear of the toast that follows it, and the conversation's
  // height never changes as a toast comes and goes.
  underBar: {
    paddingTop: { default: spacingVars['--spacing-2'], [media.phone]: spacingVars['--spacing-1'] },
    paddingBottom: {
      default: null,
      [media.phone]: `calc(${tm.target} * 2 + ${spacingVars['--spacing-1']} * 2 + ${spacingVars['--spacing-2']} * 3 + ${tm.airmailHeight} + ${spacingVars['--spacing-3']} + ${tm.safeBottom})`,
    },
  },
  // A new message's sheet fills the reader, however little is written on it.
  filled: {
    flexGrow: 1,
    display: 'flex',
    flexDirection: 'column',
  },
  // The composer lies on the desk's paper like the conversation's messages, in the same margins.
  writing: {
    paddingInline: {
      default: spacingVars['--spacing-6'],
      [media.phone]: spacingVars['--spacing-3'],
    },
    paddingBottom: spacingVars['--spacing-6'],
  },
  empty: {
    flexGrow: 1,
    display: 'grid',
    placeItems: 'center',
    padding: spacingVars['--spacing-6'],
  },
});
