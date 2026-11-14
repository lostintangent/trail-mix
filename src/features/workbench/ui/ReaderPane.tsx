import { Button } from '@astryxdesign/core/Button';
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
  ConversationSummary,
  Folder,
  Message,
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
import { hiddenIn, type Hiding } from './useComposing.ts';

/** The conversation the reader shows, with its messages and the account they belong to. */
export type Reading = { id: ConversationId; conversation: Message[]; account: Account };

/**
 * What a conversation's actions act on: the conversation once it's here, or what its row in the
 * list says while it's on its way, so they stand in the bar before it arrives.
 */
export type Acting = {
  id: ConversationId;
  account: Account;
  isFlagged: boolean;
  isUnread: boolean;
  conversation?: Message[];
};

/** Where a conversation's actions are drawn: a desktop's bar, or a phone's top bar and island. */
export type ActionsPlace = 'bar' | 'top' | 'island';

/**
 * Where the composer lies: docked under the conversation it answers, filling the reader for a
 * message of its own, or over everything on a phone, wherever it was begun.
 */
export type ComposerPlace = 'docked' | 'filled' | 'over';

/**
 * Something other than a conversation that lies on the reader's sheet in its place, with its own
 * actions where a conversation's would be, as a bundle does.
 */
export type ReaderSheet = {
  /**
   * What it shows, which the reader rests on as it does on a conversation, so a held key passing
   * it by never draws it.
   */
  id: string;
  /** What it draws, given what the reader scrolls, so it can draw only what lies in sight. */
  content: (scroller: HTMLElement | null) => ReactNode;
  /** What names its actions to assistive technology, as "Conversation" names a conversation's. */
  label: string;
  bar?: ReactNode;
  top?: ReactNode;
  island?: ReactNode;
};

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
  hiding,
  leaving,
  onOpenDraft,
  page,
  rowOf,
  sheet: selectedSheet,
  backTo,
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
  onShown: (conversation: ConversationId) => void;
  /**
   * What can be done to the conversation shown: in the reader's bar on a desktop, and on a phone
   * split between the bar at the top of the screen and the island at the bottom. The island, whose
   * Reply needs the conversation, waits for it.
   */
  actions: (acting: Acting, place: ActionsPlace) => ReactNode;
  /** Where the conversation shown sits in the list, at the end of a desktop's bar. */
  place: (shown: ConversationId) => ReactNode;
  /** What can be done with one of its messages, as the reader's own. The same function each render. */
  actionsFor: (message: Message) => readonly Command[];
  /** Keys pressed inside a message, which the window never hears. The same function each render. */
  onMessageKey: (event: KeyboardEvent) => void;
  /** The composer, while the member writes, and where it lies. */
  writing: { composer: ReactNode; place: ComposerPlace } | undefined;
  /** Drafts the reader leaves out, such as the one being written. */
  hiding: Hiding;
  /** The sends this device follows, each at the end of its conversation while it is on its way. */
  leaving: readonly Leaving[];
  /** Opens a draft in the conversation to go on writing it. */
  onOpenDraft: (draft: Message, conversation: Message[]) => void;
  /** A page that lies on the sheet in place of a conversation, such as an account's. */
  page: ReactNode;
  /**
   * A conversation's row in the list, whose subject and actions show at once while the rest is on
   * its way.
   */
  rowOf: (id: ConversationId) => ConversationSummary | undefined;
  /** What lies on the sheet while no conversation is selected, as a bundle's threads do. */
  sheet: ReaderSheet | undefined;
  /**
   * What the conversation was opened from, other than the list, as a bundle: a way back to it above
   * the conversation on a desktop, and on a phone what Back names, shorter, and goes to.
   */
  backTo: { label: string; short: string; go: () => void } | undefined;
  /** What the empty reader asks the member to choose, in the words of the list beside it. */
  choose: string | undefined;
  onBack: () => void;
}) {
  const { shown: rested, isPassing } = useRestingSelection(selectedSheet?.id ?? selected);
  // The sheet the reader rests on, which stays as it was while the selection passes from it.
  const lastSheet = useRef(selectedSheet);
  useEffect(() => {
    if (selectedSheet) lastSheet.current = selectedSheet;
  });
  const sheet = [selectedSheet, lastSheet.current].find((each) => each && each.id === rested);
  const shown = sheet || rested === lastSheet.current?.id ? undefined : rested;
  // What a sheet other than a conversation scrolls in, once it is drawn.
  const [sheetScroller, setSheetScroller] = useState<HTMLDivElement | null>(null);
  const isOffline = useReach() !== 'online';
  const {
    data: conversation,
    isPending,
    isError,
    fetchStatus,
    failureCount,
    refetch,
  } = useQuery({
    ...conversationQuery(shown ?? ''),
    enabled: shown !== undefined,
    // A reply gone from the Outbox waits for its copy, which a lost hint can't keep from showing.
    refetchInterval: ({ state: { data } }) =>
      shown && data && leavingIn(leaving, shown, data).some(isAwaitingCopy)
        ? AWAITING_COPY_MS
        : false,
  });
  const account = accounts.find(({ id }) => id === conversation?.[0]?.account);
  const reading = useMemo<Reading | undefined>(
    () =>
      shown && conversation?.length && account ? { id: shown, conversation, account } : undefined,
    [shown, conversation, account],
  );
  const isShowing = reading !== undefined;
  // Decided from the messages about to show, so the two always agree.
  const hidden = useMemo(
    () => reading && hiddenIn(hiding, reading.id, reading.conversation),
    [reading, hiding],
  );
  // Asked for and refused, or with no network asked for once in vain and waiting to ask again, as
  // for one this device didn't keep. A selection never shows the empty reader, so it says why
  // under the subject instead.
  const isUnopened =
    shown !== undefined &&
    !isShowing &&
    conversation === undefined &&
    (isError || fetchStatus === 'paused' || (isOffline && failureCount > 0));
  // On its way: asked for, and not here yet. Its skeleton stands where it will lie.
  const isOpening =
    shown !== undefined &&
    !isShowing &&
    !isUnopened &&
    (isPending || (conversation?.length ?? 0) > 0);
  // Where it sits in the list is known before it arrives, so the bar stands still as it does.
  const placed = useMemo(
    () =>
      shown !== undefined && (isShowing || isOpening || isUnopened) ? place(shown) : undefined,
    [shown, isShowing, isOpening, isUnopened, place],
  );
  // So are its actions, from its row, so the bar doesn't fill in as the conversation arrives.
  const row = shown !== undefined && (isOpening || isUnopened) ? rowOf(shown) : undefined;
  const acting = useMemo<Acting | undefined>(() => {
    if (reading) {
      const { id, account, conversation } = reading;
      return {
        id,
        account,
        conversation,
        isFlagged: conversation.some(({ flags }) => flags.flagged),
        isUnread: conversation.some(({ flags }) => !flags.seen),
      };
    }
    const account = row && accounts.find(({ id }) => id === row.account);
    return row && account
      ? { id: row.id, account, isFlagged: row.flagged, isUnread: row.unread > 0 }
      : undefined;
  }, [reading, row, accounts]);
  // Made once for each conversation shown, so the moves of a held key pass them by.
  const bar = useMemo(() => acting && actions(acting, 'bar'), [acting, actions]);
  const top = useMemo(() => acting && actions(acting, 'top'), [acting, actions]);
  const island = useMemo(
    () => acting?.conversation && actions(acting, 'island'),
    [acting, actions],
  );
  const openDraft = useMemo(
    () => reading && ((draft: Message) => onOpenDraft(draft, reading.conversation)),
    [reading, onOpenDraft],
  );
  const isDocked = writing?.place === 'docked';
  // A page lies on the sheet as a new message's composer does, filling it.
  const isFilled = writing?.place === 'filled' || page !== undefined;
  const announce = useEffectEvent((id: ConversationId) => onShown(id));
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
  usePreloadedComposer(upcoming.length > 0 || isShowing);
  // Preparing what comes next is never urgent, so a change to it, as when the open conversation
  // leaves the list, doesn't make the open conversation render again in the change's own frame.
  const preparing = useDeferredValue(upcoming);
  const crumbed = backTo && (
    <div {...stylex.props(styles.crumb)}>
      <Button
        label={backTo.label}
        icon={BACK_ICON}
        variant="ghost"
        size="sm"
        onClick={backTo.go}
        xstyle={styles.back}
      />
    </div>
  );

  return (
    <section aria-label="Reader" {...stylex.props(styles.sheet)}>
      <header {...stylex.props(styles.phoneHeader)}>
        <BackButton onClick={backTo?.go ?? onBack} label={backTo?.short} />
        {(sheet?.top ?? top) && !writing && !page ? (
          <div role="toolbar" aria-label="Marks" {...stylex.props(styles.top)}>
            <Suspense>{sheet?.top ?? top}</Suspense>
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
      {sheet?.bar && !isFilled ? (
        <div role="toolbar" aria-label={sheet.label} {...stylex.props(styles.bar)}>
          <Suspense>{sheet.bar}</Suspense>
        </div>
      ) : (bar || placed) && !isFilled ? (
        <div
          role="toolbar"
          aria-label={bar ? 'Conversation' : 'Place'}
          {...stylex.props(styles.bar)}
        >
          {bar && <Suspense>{bar}</Suspense>}
          {placed}
        </div>
      ) : null}
      {isFilled ? null : sheet ? (
        <div ref={setSheetScroller} {...stylex.props(styles.scroll, styles.underBar)}>
          {sheet.content(sheetScroller)}
        </div>
      ) : reading ? (
        <div {...stylex.props(styles.scroll, styles.underBar)}>
          {crumbed}
          <Suspense fallback={<ReaderSkeleton subject={headingOf(rowOf(reading.id))} />}>
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
          {isDocked && (
            <div {...stylex.props(styles.writing, styles.docked)}>{writing?.composer}</div>
          )}
        </div>
      ) : isOpening ? (
        <div {...stylex.props(styles.scroll, styles.underBar)}>
          {crumbed}
          <ReaderSkeleton subject={shown && headingOf(rowOf(shown))} />
        </div>
      ) : isUnopened ? (
        <div {...stylex.props(styles.scroll, styles.underBar)}>
          {crumbed}
          <ConversationUnopened
            subject={headingOf(rowOf(shown))}
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
      {(sheet ? sheet.island : island) && !writing && !page ? (
        <PhoneIsland label={sheet?.label ?? 'Conversation'} spans>
          <Suspense>{sheet ? sheet.island : island}</Suspense>
        </PhoneIsland>
      ) : null}
    </section>
  );
}

/**
 * What the reader heads a row's conversation with while it's on its way: a GitHub thread's title, as
 * the conversation's own heading reads once it comes, or else the row's subject.
 */
const headingOf = (row: ConversationSummary | undefined) =>
  row && (row.github?.title ?? row.subject);

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

/** How long the member rests from keys, pointer and scrolling before the composer loads. */
const PRELOAD_COMPOSER_AFTER_MS = 2_000;

/** What the member does to move through the list, or anything else, which the composer waits out. */
const MOVES = ['keydown', 'pointerdown', 'scroll'] as const;

/**
 * Once the first screen has something to open, the composer loads while the browser is idle, so a
 * reply rarely waits for its code. Its code is large, so it loads only once the member has rested a
 * moment, never while they move through the list.
 */
function usePreloadedComposer(isWanted: boolean) {
  useEffect(() => {
    if (!isWanted) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let idleId: number | undefined;
    const settle = () => {
      clearTimeout(timer);
      if (idleId !== undefined) cancelIdleCallback(idleId);
      idleId = undefined;
      timer = setTimeout(() => {
        // Safari has no idle callback.
        if ('requestIdleCallback' in window) idleId = requestIdleCallback(preload);
        else preload();
      }, PRELOAD_COMPOSER_AFTER_MS);
    };
    const stop = () => {
      clearTimeout(timer);
      if (idleId !== undefined) cancelIdleCallback(idleId);
      for (const move of MOVES) window.removeEventListener(move, settle, { capture: true });
    };
    const preload = () => {
      stop();
      // One that fails, as offline, is loaded again when the composer opens.
      void Promise.all([preloadComposer(), preloadSendActions()]).catch(() => {});
    };
    for (const move of MOVES) {
      window.addEventListener(move, settle, { capture: true, passive: true });
    }
    settle();
    return stop;
  }, [isWanted]);
}

function usePreloadedReader(isWanted: boolean) {
  useEffect(() => {
    if (!isWanted) return;
    const timer = setTimeout(() => {
      // Safari has no idle callback.
      const load = () => {
        // One that fails, as offline, is loaded again when a conversation opens.
        void Promise.all([preloadReader(), preloadTriageMenus()]).catch(() => {});
      };
      if ('requestIdleCallback' in window) requestIdleCallback(load);
      else load();
    }, PRELOAD_AFTER_MS);
    return () => clearTimeout(timer);
  }, [isWanted]);
}

const BACK_ICON = <Icon icon={ChevronLeft} />;

// The header with Back is a phone's, and hidden on wider screens, so it costs nothing as the
// reader changes. Back to something other than the list names it.
const BackButton = memo(function BackButton({
  onClick,
  label,
}: {
  onClick: () => void;
  label: string | undefined;
}) {
  return label === undefined ? (
    <IconButton label="Back" icon={BACK_ICON} variant="ghost" onClick={onClick} />
  ) : (
    <Button
      label={label}
      aria-label={`Back to ${label}`}
      icon={BACK_ICON}
      variant="ghost"
      onClick={onClick}
      xstyle={styles.back}
    />
  );
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
    scrollbarWidth: 'thin',
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
  // A way back above the conversation, at the subject's margin. A phone's Back names it instead.
  crumb: {
    display: { default: 'flex', [media.phone]: 'none' },
    paddingInline: spacingVars['--spacing-5'],
  },
  back: {
    paddingInlineStart: spacingVars['--spacing-1'],
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
      default: spacingVars['--spacing-4'],
      [media.phone]: spacingVars['--spacing-3'],
    },
    paddingBottom: spacingVars['--spacing-6'],
  },
  // Docked, it takes back the room the conversation ends with, so it lies a message's gap under
  // the last message, where the reply will lie once sent.
  docked: {
    marginTop: `calc(${spacingVars['--spacing-2']} - ${spacingVars['--spacing-6']})`,
  },
  empty: {
    flexGrow: 1,
    display: 'grid',
    placeItems: 'center',
    padding: spacingVars['--spacing-6'],
  },
});
