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
  useDeferredValue,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { media, tm } from '../../../app/theme/tokens.stylex.ts';
import { afterPaint } from '../../../shared/afterPaint.ts';
import type { Command } from '../../commands/index.ts';
import type { InBundle } from '../../conversations/index.ts';
import { folderName } from '../../folders/index.ts';
import {
  bundlePartsOf,
  isBundle,
  type Account,
  type AccountId,
  type BundleId,
  type ConversationId,
  type ConversationSummary,
  type Folder,
  type ListItem,
  type Message,
} from '../../mail/core/index.ts';
import { conversationQuery } from '../../mailroom/client/index.ts';
import { isAwaitingCopy, leavingIn, type Leaving } from '../../outbox/index.ts';
import { useReach } from '../../offline/index.ts';
import {
  BundleReader,
  BundleSkeleton,
  ConversationUnopened,
  Reader,
  ReaderSkeleton,
} from '../../reader/index.ts';
import { PhoneIsland } from './PhoneIsland.tsx';
import { usePreloadedComposer, usePreloadedReader } from './usePreloads.ts';
import { useRestingSelection } from './useRestingSelection.ts';
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
 * The bundle selected in the list. While none of its threads is open, its threads lie on the
 * reader's sheet in place of a conversation's messages, with its actions where a conversation's are.
 * A thread open in it lies there instead, under the bundle's name as the way back.
 */
export type OpenBundle = {
  id: BundleId;
  /** Its row in the list, which names its repository while the bundle is on its way. */
  row: ListItem | undefined;
  in: InBundle;
  /** Whether it waits for the page that holds the thread a place arrived naming. */
  awaitsThread: boolean;
  /** Where the thread last open in it lies, which its threads show in sight. */
  cameFromAt: number | undefined;
  onOpen: (thread: ConversationId) => void;
  onClose: () => void;
  /** What can be done to it, drawn where a conversation's actions are. */
  actions: (place: ActionsPlace) => ReactNode;
};

/**
 * The reader's sheet, where an open conversation lies, or a bundle's threads. On a phone it fills
 * the screen, with a way back to the list at its top. The reader itself loads soon after the list
 * shows a conversation to open, while the browser is idle, ready for the click.
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
  bundle,
  choose = 'Choose one from the list to read it here.',
  onBack,
}: {
  /** The conversation to show: the one selected, or a thread open in the bundle selected. */
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
  /** Where the conversation or bundle shown sits in the list, at the end of a desktop's bar. */
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
  /** The bundle selected, whose threads lie on the sheet while no thread of it is shown. */
  bundle: OpenBundle | undefined;
  /** What the empty reader asks the member to choose, in the words of the list beside it. */
  choose: string | undefined;
  onBack: () => void;
}) {
  // The bundle whose threads lie on the sheet, while none of them is open in its place.
  const listing = bundle && selected === undefined ? bundle : undefined;
  const { shown: rested, isPassing } = useRestingSelection(listing?.id ?? selected);
  // The bundle the reader rests on, which stays as it was while the selection passes from it.
  const lastListing = useRef(listing);
  useEffect(() => {
    if (listing) lastListing.current = listing;
  });
  const listed = [listing, lastListing.current].find((each) => each && each.id === rested);
  const shown = listed || rested === lastListing.current?.id ? undefined : rested;
  const listedAccount = listed && bundlePartsOf(listed.id)?.account;
  // What a bundle's threads scroll in, once they are drawn.
  const [threadsScroller, setThreadsScroller] = useState<HTMLDivElement | null>(null);
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
  // A bundle's actions stand where a conversation's do.
  const bundleBar = listed?.actions('bar');
  const bundleTop = listed?.actions('top');
  const bundleIsland = listed?.actions('island');
  // A thread open in its bundle lies under the bundle's name, the way back to its threads, which a
  // phone's Back names shorter.
  const repository = bundle && repositoryOf(bundle);
  const backTo =
    bundle && selected !== undefined && repository
      ? {
          label: repository,
          short: repository.slice(repository.indexOf('/') + 1),
          go: bundle.onClose,
        }
      : undefined;
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
        {(bundleTop ?? top) && !writing && !page ? (
          <div role="toolbar" aria-label="Marks" {...stylex.props(styles.top)}>
            <Suspense>{bundleTop ?? top}</Suspense>
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
      {listed && bundleBar && !isFilled ? (
        <div role="toolbar" aria-label="Repository" {...stylex.props(styles.bar)}>
          <Suspense>
            {bundleBar}
            {place(listed.id)}
          </Suspense>
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
      {isFilled ? null : listed ? (
        <div ref={setThreadsScroller} {...stylex.props(styles.scroll, styles.underBar)}>
          {listed.in.bundle && listed.in.threads && !listed.awaitsThread ? (
            <Suspense fallback={<BundleSkeleton repository={repositoryOf(listed)} />}>
              <BundleReader
                bundle={listed.in.bundle}
                threads={listed.in.threads}
                account={accounts.find(({ id }) => id === listedAccount)}
                folder={inboxNameOf(folders, listedAccount)}
                scroller={threadsScroller}
                onOpen={listed.onOpen}
                onShown={listed.in.show}
                from={listed.cameFromAt}
              />
            </Suspense>
          ) : listed.in.isError ? (
            <ConversationUnopened
              subject={repositoryOf(listed)}
              isOffline={isOffline}
              onTryAgain={listed.in.refetch}
            />
          ) : (
            <BundleSkeleton repository={repositoryOf(listed) || undefined} />
          )}
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
      {(listed ? bundleIsland : island) && !writing && !page ? (
        <PhoneIsland label={listed ? 'Repository' : 'Conversation'} spans>
          <Suspense>{listed ? bundleIsland : island}</Suspense>
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

/** The repository a bundle gathers, as its newest thread writes it, once it or its row says. */
const repositoryOf = ({ in: { bundle }, row }: OpenBundle) =>
  bundle?.repository ?? (row && isBundle(row) ? row.repository : '');

/** What the member calls an account's Inbox, where its bundles' threads lie. */
const inboxNameOf = (folders: readonly Folder[], account: AccountId | undefined) => {
  const inbox = folders.find((folder) => folder.account === account && folder.role === 'inbox');
  return inbox ? folderName(inbox) : 'Inbox';
};

/** How often a conversation is fetched again while a reply that left it waits for its copy. */
const AWAITING_COPY_MS = 2_000;

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
