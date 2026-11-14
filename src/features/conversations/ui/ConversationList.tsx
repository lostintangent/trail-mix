import { Icon } from '@astryxdesign/core/Icon';
import { Skeleton } from '@astryxdesign/core/Skeleton';
import {
  colorVars,
  durationVars,
  focusVars,
  fontWeightVars,
  radiusVars,
  spacingVars,
  typeScaleVars,
  typographyVars,
} from '@astryxdesign/core/theme/tokens.stylex';
import { VisuallyHidden } from '@astryxdesign/core/VisuallyHidden';
import * as stylex from '@stylexjs/stylex';
import {
  defaultRangeExtractor,
  observeElementOffset,
  useVirtualizer,
} from '@tanstack/react-virtual';
import { Paperclip, Star } from 'lucide-react';
import {
  memo,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  useMemo,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type RefObject,
} from 'react';
import { Pending, pendingStyles, TextSkeleton } from '../../../app/theme/Pending.tsx';
import { SenderAvatar } from '../../../app/theme/SenderAvatar.tsx';
import { media, scrollFade, scrollFades, tm } from '../../../app/theme/tokens.stylex.ts';
import {
  isBundle,
  type BundleSummary,
  type ConversationId,
  type ConversationSummary,
  type ListItem,
  type Marks,
  type StampColor,
} from '../../mail/core/index.ts';
import { avatarUrl } from '../../mailroom/client/index.ts';
import { peopleOf } from '../core/face.ts';
import { numberOf } from '../core/github.ts';
import type { Listed } from '../core/pages.ts';
import type { SelectBy, Selection } from '../core/selection.ts';
import { formatListDate } from './dates.ts';
import { BundleChips } from './github.tsx';
import { Marked } from './search.tsx';

/** A row's height before the list is first laid out: three lines of text and the row's padding. */
const FIRST_GUESS = 72;

/**
 * A lifted row's ring, a selection's or a swipe's, lies a pixel outside it. The list keeps that
 * pixel at both its ends, and beside a row it scrolls to, so the scroller never clips the ring.
 */
const RING = 1;

/** How many rows beyond those in sight the list says it shows, so their pages arrive in time. */
const AHEAD = 30;

/** How long a finger rests on a row before it starts picking, and how far it may drift meanwhile. */
const LONG_PRESS_MS = 500;
const LONG_PRESS_SLOP = 10;

/** How far left, as a share of its width, a finger swipes a row before letting go archives it. */
const SWIPE_SHARE = 0.4;

/**
 * The conversations of a view, newest first, drawn only where the list is scrolled to. In an Inbox
 * view, a repository's GitHub notifications stand together as one row, its bundle. The list is
 * as long as the view, and a row whose page hasn't arrived stands as a skeleton until it has. Rows
 * arriving or leaving above the top row in sight leave it where it is, so mail that arrives while
 * the list is scrolled down moves nothing, while at the top it shows. Selected conversations lift
 * from the sheet onto paper. The list takes focus as one control and moves its selection with the
 * arrow keys, Home, End and the page keys, and Shift extends it. A key that lands on a row still on
 * its way selects it once it arrives. A click selects one, Cmd or Ctrl adds or removes one, and
 * Shift selects the range from the last pick. A finger held on a row starts picking, and while
 * picking, a tap adds or removes. A finger that swipes a row far enough to the left archives it.
 * Arrow keys draw focus around the active row, not the sheet the list lies on.
 */
export function ConversationList({
  label,
  listKey,
  conversations,
  marks,
  isUpdating,
  stamps,
  selves,
  selection,
  isPicking,
  onSelect,
  onLongPress,
  onPick,
  onSwipe,
  onAhead,
  onShown,
}: {
  label: string;
  /** Names the list shown. Another list starts at its top. */
  listKey: string;
  /** Every row in the list, with those whose page hasn't arrived yet empty. */
  conversations: Listed<ListItem>;
  /** What a search matched, marked in each row. The same while the search stays the same. */
  marks: Marks;
  /** Whether newer rows are on their way, as while a search is typed. */
  isUpdating: boolean;
  /** Each account's stamp color, by account id, where the list mixes accounts. Elsewhere none shows. */
  stamps: ReadonlyMap<string, StampColor> | undefined;
  /** The member's own addresses, lowercased, whom a row passes over for the others in it. */
  selves: ReadonlySet<string>;
  selection: Selection;
  /** Whether a tap adds a row to the selection, as after a long press, instead of opening it. */
  isPicking: boolean;
  onSelect: (id: ConversationId, by: SelectBy) => void;
  onLongPress: (id: ConversationId) => void;
  /** Picks a row, or lets it go while picking, as a finger tapping its avatar does. */
  onPick: (id: ConversationId) => void;
  onSwipe: (id: ConversationId) => void;
  /**
   * Called as a conversation is about to be opened, ahead of the click: once the pointer rests on
   * its row, and again with `isPressed` as a mouse or pen presses it. The same function each render.
   */
  onAhead: (id: ConversationId, isPressed: boolean) => void;
  /**
   * Says which rows the list shows: from the first to the last in sight, with some to spare either
   * side, and the selected one, which stays drawn out of sight.
   */
  onShown: (first: number, last: number, selected: number) => void;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const ruler = useRef<HTMLDivElement>(null);
  const [isKeyboardFocused, setKeyboardFocused] = useState(false);
  const listId = useId();
  const rowHeight = useRowHeight(ruler);
  const padding = useScrollPadding(scroller, rowHeight);
  // The row the keys move from and the list names as active: the last one picked, or the end of a
  // range that moved last.
  const selectedIndex = useMemo(() => {
    const { active } = selection;
    return active === undefined ? -1 : conversations.findIndex((row) => row?.id === active);
  }, [conversations, selection]);
  const selected = useMemo(() => new Set(selection.ids), [selection.ids]);
  const reportOffset = useRef<(offset: number, isScrolling: boolean) => void>(null);
  const virtualizer = useVirtualizer({
    count: conversations.length,
    getScrollElement: () => scroller.current,
    observeElementOffset: (instance, report) => {
      reportOffset.current = report;
      return observeElementOffset(instance, report);
    },
    // Every row is one height, so the list places rows by their index alone, and nothing is
    // measured again as rows arrive.
    estimateSize: () => rowHeight,
    overscan: 6,
    paddingStart: RING,
    paddingEnd: RING,
    // A row scrolled to lands clear of the scroll padding, as one a browser scrolls to itself does.
    scrollPaddingStart: padding.start + RING,
    scrollPaddingEnd: padding.end + RING,
    // The selected row stays drawn when it scrolls away, since the list names it as the active one.
    rangeExtractor: (range) => {
      const drawn = defaultRangeExtractor(range);
      return selectedIndex < 0 || drawn.includes(selectedIndex)
        ? drawn
        : [...drawn, selectedIndex].sort((a, b) => a - b);
    },
  });
  useLayoutEffect(() => virtualizer.measure(), [virtualizer, rowHeight]);
  const drawn = virtualizer.getVirtualItems();
  const inSight = virtualizer.range;
  /** Scrolls the list to `top`, and tells the virtualizer at once, so this commit draws the rows. */
  const scrollTo = (top: number) => {
    const list = scroller.current;
    if (!list || list.scrollTop === top) return;
    list.scrollTop = top;
    reportOffset.current?.(list.scrollTop, false);
  };
  // The top row in sight stays put while rows above it come and go, unless it is the list's first.
  const topRow = useRef<{
    rows: Listed<ListItem>;
    list: string;
    id: ConversationId;
    index: number;
  }>(undefined);
  useLayoutEffect(() => {
    const was = topRow.current;
    if (was && was.rows !== conversations && was.list === listKey && was.index > 0) {
      const index = conversations.findIndex((row) => row?.id === was.id);
      if (index >= 0 && index !== was.index) {
        scrollTo((scroller.current?.scrollTop ?? 0) + (index - was.index) * rowHeight);
        topRow.current = { ...was, rows: conversations, index };
        return;
      }
    }
    const at = inSight?.startIndex ?? 0;
    const row = conversations[at];
    topRow.current = row && { rows: conversations, list: listKey, id: row.id, index: at };
  });
  // Another list starts at its top.
  const listShown = useRef(listKey);
  useLayoutEffect(() => {
    if (listShown.current === listKey) return;
    listShown.current = listKey;
    scrollTo(0);
  });
  // A selection moved from elsewhere, as by J and K, scrolls into view, and so does one whose row
  // arrives after it. Rows coming and going above it move it in the list but not in sight, so they
  // don't scroll. The list's own keys scroll as they move, in the same commit, so they're left alone.
  const isMovedHere = useRef(false);
  const selectedAt = useRef(selectedIndex);
  useLayoutEffect(() => {
    selectedAt.current = selectedIndex;
  });
  const isSelectedListed = selectedIndex >= 0;
  useLayoutEffect(() => {
    if (isMovedHere.current) isMovedHere.current = false;
    else if (isSelectedListed) virtualizer.scrollToIndex(selectedAt.current, { align: 'auto' });
  }, [virtualizer, selection.active, isSelectedListed]);
  const first = Math.max(0, (inSight?.startIndex ?? 0) - AHEAD);
  const last = (inSight?.endIndex ?? 0) + AHEAD;
  useEffect(() => {
    onShown(first, last, selectedIndex);
  }, [first, last, selectedIndex, onShown]);
  // A key that moves to a row whose page hasn't arrived selects it once it has, unless the selection
  // moved on meanwhile.
  const awaited = useRef<{ index: number; by: SelectBy }>(undefined);
  useEffect(() => {
    awaited.current = undefined;
  }, [selection.active]);
  useLayoutEffect(() => {
    const row = awaited.current && conversations[awaited.current.index];
    if (!row || !awaited.current) return;
    const { by } = awaited.current;
    awaited.current = undefined;
    onSelect(row.id, by);
  }, [conversations, onSelect]);
  const optionId = (index: number) => `${listId}-${index}`;

  const move = (event: KeyboardEvent<HTMLDivElement>) => {
    const clear = (scroller.current?.clientHeight ?? 0) - padding.start - padding.end;
    const page = Math.max(1, Math.floor(clear / rowHeight) - 1);
    const last = conversations.length - 1;
    const from = selectedIndex < 0 ? -1 : selectedIndex;
    const to = {
      ArrowDown: Math.min(last, from + 1),
      ArrowUp: Math.max(0, from - 1),
      PageDown: Math.min(last, from + page),
      PageUp: Math.max(0, from - page),
      Home: 0,
      End: last,
    }[event.key];
    if (to === undefined || to < 0) return;
    event.preventDefault();
    setKeyboardFocused(true);
    const target = conversations[to];
    const by = event.shiftKey ? 'extend' : 'only';
    if (target) {
      isMovedHere.current = true;
      onSelect(target.id, by);
    } else awaited.current = { index: to, by };
    // A move that scrolls the list tells the virtualizer where it went at once, instead of in the
    // next frame's scroll event. So the rows it brings in render in the selection's own commit, and
    // that scroll event, finding the offset already known, renders nothing.
    const scrolledFrom = scroller.current?.scrollTop;
    virtualizer.scrollToIndex(to, { align: 'auto' });
    const scrolledTo = scroller.current?.scrollTop;
    if (scrolledTo !== undefined && scrolledTo !== scrolledFrom)
      reportOffset.current?.(scrolledTo, true);
  };

  return (
    <div
      ref={scroller}
      role="listbox"
      aria-label={label}
      aria-multiselectable
      aria-activedescendant={selectedIndex < 0 ? undefined : optionId(selectedIndex)}
      aria-busy={isUpdating || drawn.some(({ index }) => !conversations[index])}
      tabIndex={0}
      onKeyDown={move}
      onPointerDown={() => setKeyboardFocused(false)}
      onFocus={() => setKeyboardFocused(scroller.current?.matches(':focus-visible') ?? false)}
      onBlur={() => setKeyboardFocused(false)}
      {...stylex.props(styles.scroller)}
    >
      <RowRuler ref={ruler} />
      <div {...stylex.props(styles.canvas(virtualizer.getTotalSize()))}>
        {drawn.map(({ index, start }) => {
          const item = conversations[index];
          if (!item) return <RowSkeleton key={`pending ${index}`} row={index} top={start} />;
          return (
            <Row
              key={item.id}
              id={optionId(index)}
              item={item}
              marks={marks}
              stamp={stamps?.get(item.account)}
              selves={selves}
              top={start}
              position={index + 1}
              size={conversations.length}
              isSelected={selected.has(item.id)}
              isKeyboardFocused={isKeyboardFocused && selectedIndex === index}
              isPicking={isPicking}
              onSelect={onSelect}
              onLongPress={onLongPress}
              onPick={onPick}
              onSwipe={onSwipe}
              onAhead={onAhead}
            />
          );
        })}
      </div>
    </div>
  );
}

/**
 * One conversation, or a bundle. Memoized, so moving the selection redraws only the two rows it
 * touches.
 */
const Row = memo(function Row({
  id,
  item,
  marks,
  stamp,
  selves,
  top,
  position,
  size,
  isSelected,
  isKeyboardFocused,
  isPicking,
  onSelect,
  onLongPress,
  onPick,
  onSwipe,
  onAhead,
}: {
  id: string;
  item: ListItem;
  marks: Marks;
  stamp: StampColor | undefined;
  selves: ReadonlySet<string>;
  top: number;
  position: number;
  size: number;
  isSelected: boolean;
  isKeyboardFocused: boolean;
  isPicking: boolean;
  onSelect: (id: ConversationId, by: SelectBy) => void;
  onLongPress: (id: ConversationId) => void;
  onPick: (id: ConversationId) => void;
  onSwipe: (id: ConversationId) => void;
  onAhead: (id: ConversationId, isPressed: boolean) => void;
}) {
  const people = isBundle(item) ? undefined : peopleOf(item, selves);
  // A bundle leads with GitHub's picture, which its newest conversation names.
  const name = people ? (people.face ? people.face.name || people.face.email : '') : 'GitHub';
  // A finger that taps the avatar picks the row instead of opening it.
  const pointer = useRef('');
  const touch = useTouch(
    () => onLongPress(item.id),
    () => onSwipe(item.id),
  );
  const ahead = useAhead((isPressed) => onAhead(item.id, isPressed));
  const select = (event: MouseEvent) => {
    if (touch.tookClick()) return;
    const by: SelectBy = event.shiftKey
      ? 'extend'
      : event.metaKey || event.ctrlKey || isPicking
        ? 'toggle'
        : 'only';
    onSelect(item.id, by);
  };
  return (
    <div
      id={id}
      role="option"
      aria-selected={isSelected}
      aria-posinset={position}
      aria-setsize={size}
      onClick={select}
      {...touch.handlers}
      onPointerDown={(event) => {
        ahead.onPointerDown(event);
        touch.handlers.onPointerDown(event);
      }}
      onPointerEnter={ahead.onPointerEnter}
      onPointerLeave={ahead.onPointerLeave}
      {...stylex.props(
        styles.row,
        styles.placed(top),
        isSelected && styles.selected,
        isKeyboardFocused && styles.keyboardFocused,
      )}
    >
      <span
        onPointerDown={(event) => (pointer.current = event.pointerType)}
        onClick={(event) => {
          if (pointer.current !== 'touch') return;
          event.stopPropagation();
          if (!touch.tookClick()) onPick(item.id);
        }}
        {...stylex.props(styles.avatar)}
      >
        <SenderAvatar name={name} picture={item.avatar && avatarUrl(item.avatar)} stamp={stamp} />
      </span>
      {isBundle(item) ? (
        <BundleLines bundle={item} />
      ) : (
        <ConversationLines conversation={item} marks={marks} names={people?.names} />
      )}
    </div>
  );
});

/** A conversation's three lines: whom it is with, its subject and its preview. */
function ConversationLines({
  conversation,
  marks,
  names,
}: {
  conversation: ConversationSummary;
  marks: Marks;
  names: string | undefined;
}) {
  const { subject, preview, date, unread, flagged, hasAttachments } = conversation;
  const isUnread = unread > 0;
  return (
    <span {...stylex.props(styles.lines)}>
      <span {...stylex.props(styles.top, styles.line)}>
        {isUnread && <span {...stylex.props(styles.dot)} />}
        <span {...stylex.props(styles.sender, isUnread && styles.senderUnread, styles.clip)}>
          {names === undefined ? (
            <span {...stylex.props(styles.nobody)}>No recipients</span>
          ) : (
            <Marked text={names} marks={marks} />
          )}
        </span>
        <RowMarks isUnread={isUnread} flagged={flagged} hasAttachments={hasAttachments} />
        <time dateTime={date} {...stylex.props(styles.time)}>
          {formatListDate(date)}
        </time>
      </span>
      <span {...stylex.props(isUnread && styles.subjectUnread, styles.clip, styles.line)}>
        {subject ? <Marked text={subject} marks={marks} /> : '(no subject)'}
      </span>
      <span {...stylex.props(styles.preview, styles.clip, styles.line)}>
        <Marked text={preview} marks={marks} />
      </span>
    </span>
  );
}

/**
 * A bundle's three lines: its repository, its owner in quiet ink, then its newest thread's title
 * and number, then a chip for each of its first threads.
 */
function BundleLines({ bundle }: { bundle: BundleSummary }) {
  const { repository, newest, date, unread, flagged, chips, threads } = bundle;
  const isUnread = unread > 0;
  const slash = repository.indexOf('/') + 1;
  const number = numberOf(newest);
  return (
    <span {...stylex.props(styles.lines)}>
      <span {...stylex.props(styles.top, styles.line)}>
        {isUnread && <span {...stylex.props(styles.dot)} />}
        <span {...stylex.props(styles.sender, isUnread && styles.senderUnread, styles.clip)}>
          <span {...stylex.props(styles.owner)}>{repository.slice(0, slash)}</span>
          {repository.slice(slash)}
        </span>
        <RowMarks isUnread={isUnread} flagged={flagged} hasAttachments={false} />
        <time dateTime={date} {...stylex.props(styles.time)}>
          {formatListDate(date)}
        </time>
      </span>
      <span {...stylex.props(isUnread && styles.subjectUnread, styles.clip, styles.line)}>
        {newest.title}
        {number && (
          <>
            {' '}
            <span {...stylex.props(styles.owner, number.isCommit && styles.commit)}>
              {number.text}
            </span>
          </>
        )}
      </span>
      <span {...stylex.props(styles.preview, styles.line, styles.chipLine)}>
        <BundleChips chips={chips} threads={threads} />
      </span>
    </span>
  );
}

/** What a row's first line says beside its name: unread, flagged and attached. */
function RowMarks({
  isUnread,
  flagged,
  hasAttachments,
}: {
  isUnread: boolean;
  flagged: boolean;
  hasAttachments: boolean;
}) {
  return (
    <>
      {isUnread && <VisuallyHidden>Unread</VisuallyHidden>}
      {flagged && <Icon icon={Star} size="xsm" label="Flagged" xstyle={styles.flag} />}
      {hasAttachments && (
        <Icon icon={Paperclip} size="xsm" label="Has attachments" xstyle={styles.quiet} />
      )}
    </>
  );
}

/**
 * A list on its way: rows in the shape of its conversations, each one row's height, as the ruler
 * measures it, so the first page lands where they stood.
 */
export function ConversationListSkeleton({ label }: { label: string }) {
  return (
    <Pending label={`Loading ${label}`} xstyle={styles.skeletons} holdsPlace={false}>
      {Array.from({ length: SKELETON_ROWS }, (_, row) => (
        <SkeletonRow key={row} row={row} xstyle={styles.standing} />
      ))}
    </Pending>
  );
}

/**
 * A row in the list whose page is on its way, where the row will lie. It shows only once late, and
 * assistive technology hears the list is busy instead.
 */
function RowSkeleton({ row, top }: { row: number; top: number }) {
  return <SkeletonRow row={row} xstyle={[styles.placed(top), pendingStyles.late]} />;
}

/** A row in the shape of a conversation's, its lines of lengths that differ from row to row. */
function SkeletonRow({ row, xstyle }: { row: number; xstyle: stylex.StyleXStyles }) {
  const width = (widths: readonly string[]) => widths[row % widths.length] ?? '50%';
  return (
    <div aria-hidden {...stylex.props(styles.row, styles.pending, xstyle)}>
      <span {...stylex.props(styles.avatar)}>
        <Skeleton width="32px" height="32px" radius="rounded" index={row} />
      </span>
      <span {...stylex.props(styles.lines)}>
        <span {...stylex.props(styles.top, styles.line)}>
          <span {...stylex.props(styles.sender, styles.grow)}>
            <TextSkeleton width={width(SENDER_WIDTHS)} index={row} />
          </span>
          <span {...stylex.props(styles.time)}>
            <TextSkeleton width="3em" index={row} />
          </span>
        </span>
        <span {...stylex.props(styles.line)}>
          <TextSkeleton width={width(SUBJECT_WIDTHS)} index={row} />
        </span>
        <span {...stylex.props(styles.preview, styles.line)}>
          <TextSkeleton width={width(PREVIEW_WIDTHS)} index={row} />
        </span>
      </span>
    </div>
  );
}

/** Enough rows to fill a tall window, with lines of differing lengths, as mail has. */
const SKELETON_ROWS = 16;
const SENDER_WIDTHS = ['38%', '52%', '30%', '45%', '60%'];
const SUBJECT_WIDTHS = ['72%', '58%', '84%', '64%', '76%', '50%'];
const PREVIEW_WIDTHS = ['92%', '86%', '96%', '80%'];

/**
 * When a row is about to be opened: once a mouse rests on it, which a pointer passing over it on
 * its way elsewhere doesn't, and as a mouse or pen presses it, a moment before the click. A finger
 * that touches a row may be starting a scroll, so it says nothing.
 */
function useAhead(onAhead: (isPressed: boolean) => void) {
  const resting = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(resting.current), []);
  return {
    onPointerEnter: (event: PointerEvent) => {
      if (event.pointerType !== 'mouse') return;
      clearTimeout(resting.current);
      resting.current = setTimeout(() => onAhead(false), REST_MS);
    },
    onPointerLeave: () => clearTimeout(resting.current),
    onPointerDown: (event: PointerEvent) => {
      clearTimeout(resting.current);
      if (event.pointerType !== 'touch') onAhead(true);
    },
  };
}

/** How long a mouse rests on a row before the row counts as about to be opened. */
const REST_MS = 150;

/**
 * What a finger does to a row. Held still for a moment, it starts picking. Moved sideways first, it
 * swipes the row, which follows it left, and let go past `SWIPE_SHARE` of the row's width, archives
 * it, or else slides back. Moved up or down first, it scrolls the list as usual. After a long press
 * or a swipe, the click that ends it isn't a click, and a touch screen's context menu doesn't open.
 */
function useTouch(onLongPress: () => void, onSwipe: () => void) {
  const gesture = useRef<{
    x: number;
    y: number;
    timer: ReturnType<typeof setTimeout>;
    row: HTMLElement;
    isSwiping: boolean;
  }>(null);
  const isClickTaken = useRef(false);
  const end = () => {
    if (gesture.current) clearTimeout(gesture.current.timer);
    gesture.current = null;
  };
  const letGo = (event: PointerEvent, canArchive: boolean) => {
    const at = gesture.current;
    end();
    if (!at?.isSwiping) return;
    isClickTaken.current = true;
    if (canArchive && at.x - event.clientX > at.row.offsetWidth * SWIPE_SHARE) onSwipe();
    slideBack(at.row);
  };
  return {
    tookClick: () => {
      const taken = isClickTaken.current;
      isClickTaken.current = false;
      return taken;
    },
    handlers: {
      onPointerDown: (event: PointerEvent<HTMLElement>) => {
        if (event.pointerType === 'mouse') return;
        isClickTaken.current = false;
        const timer = setTimeout(() => {
          isClickTaken.current = true;
          gesture.current = null;
          onLongPress();
        }, LONG_PRESS_MS);
        gesture.current = {
          x: event.clientX,
          y: event.clientY,
          timer,
          row: event.currentTarget,
          isSwiping: false,
        };
      },
      onPointerMove: (event: PointerEvent<HTMLElement>) => {
        const at = gesture.current;
        if (!at) return;
        const dx = event.clientX - at.x;
        const dy = event.clientY - at.y;
        if (!at.isSwiping) {
          if (Math.hypot(dx, dy) <= LONG_PRESS_SLOP) return;
          clearTimeout(at.timer);
          if (Math.abs(dx) <= Math.abs(dy) || dx > 0) return end();
          at.isSwiping = true;
          at.row.setPointerCapture(event.pointerId);
          at.row.classList.add(...classesOf(swiping.lifted));
        }
        at.row.style.setProperty(SWIPE, `${Math.min(0, dx)}px`);
      },
      onPointerUp: (event: PointerEvent) => letGo(event, true),
      onPointerCancel: (event: PointerEvent) => letGo(event, false),
      onContextMenu: (event: MouseEvent) => {
        if (isClickTaken.current || gesture.current) event.preventDefault();
      },
    },
  };
}

/** The custom property a swipe moves its row by. */
const SWIPE = '--tm-swipe';

/** Slides a swiped row back into place, and lowers it onto the sheet again. */
function slideBack(row: HTMLElement) {
  const settling = classesOf(swiping.settling);
  row.classList.add(...settling);
  row.style.setProperty(SWIPE, '0px');
  const done = () => row.classList.remove(...settling, ...classesOf(swiping.lifted));
  row.addEventListener('transitionend', done, { once: true });
  // Under reduced motion there is no transition to end.
  setTimeout(done, 300);
}

const classesOf = (style: stylex.StyleXStyles) => stylex.props(style).className?.split(' ') ?? [];

/**
 * An empty row, out of sight, that the list measures for every row's height. Each of a row's three
 * lines is exactly one line of its type tall, whatever it holds or leaves empty, so the height
 * follows from the row's type and padding alone. No row's content can change it, while a coarse
 * pointer's padding or a larger text size changes it for every row at once.
 */
function RowRuler({ ref }: { ref: RefObject<HTMLDivElement | null> }) {
  return (
    <div ref={ref} aria-hidden {...stylex.props(styles.row, styles.ruler)}>
      <span {...stylex.props(styles.avatar)} />
      <span {...stylex.props(styles.lines)}>
        <span {...stylex.props(styles.top, styles.line)} />
        <span {...stylex.props(styles.line)} />
        <span {...stylex.props(styles.preview, styles.line)} />
      </span>
    </div>
  );
}

/**
 * Every row's height, as the ruler measures it, so the list places rows by arithmetic. It is read
 * before the list is first drawn, and again whenever the ruler's size changes. It is rounded up to a
 * whole pixel, so rows start on whole pixels and a scroll lands exactly where it was asked to.
 */
function useRowHeight(ruler: RefObject<HTMLDivElement | null>): number {
  const [height, setHeight] = useState(FIRST_GUESS);
  useLayoutEffect(() => {
    const element = ruler.current;
    if (!element) return;
    setHeight(Math.ceil(element.getBoundingClientRect().height));
    const observer = new ResizeObserver(([entry]) => {
      const size = entry?.borderBoxSize[0]?.blockSize;
      if (size !== undefined) setHeight(Math.ceil(size));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [ruler]);
  return height;
}

/**
 * The scroller's scroll padding, in pixels, which the list keeps a row it scrolls to clear of. It is
 * read again as the scroller's size changes, as between a phone's layout and a desktop's or as a
 * phone turns, and as the row height does, since a coarse pointer resizes what floats over the list.
 */
function useScrollPadding(
  scroller: RefObject<HTMLDivElement | null>,
  rowHeight: number,
): { start: number; end: number } {
  const [padding, setPadding] = useState({ start: 0, end: 0 });
  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const read = () => {
      const style = getComputedStyle(element);
      const start = parseFloat(style.scrollPaddingBlockStart) || 0;
      const end = parseFloat(style.scrollPaddingBlockEnd) || 0;
      setPadding((was) => (was.start === start && was.end === end ? was : { start, end }));
    };
    read();
    const observer = new ResizeObserver(read);
    observer.observe(element);
    return () => observer.disconnect();
  }, [scroller, rowHeight]);
  return padding;
}

/** Only a browser that can drive an animation by scrolling fades the list's ends. */
const SCROLL_DRIVEN = '@supports (animation-timeline: scroll())';

/**
 * The list's top fades in over the first stretch of scrolling, and its foot out over the last. Each
 * keeps its own linear pace, so the list needs no class for one.
 */
const fadeStart = stylex.keyframes({
  from: { [scrollFades.start]: '0px', animationTimingFunction: 'linear' },
  to: { [scrollFades.start]: scrollFade.depth },
});
const fadeEnd = stylex.keyframes({
  from: { [scrollFades.end]: scrollFade.depth, animationTimingFunction: 'linear' },
  to: { [scrollFades.end]: '0px' },
});

const styles = stylex.create({
  scroller: {
    position: 'relative',
    height: '100%',
    overflowY: 'auto',
    scrollbarWidth: 'thin',
    overscrollBehavior: 'contain',
    paddingInline: spacingVars['--spacing-1-5'],
    paddingBlockEnd: tm.listFoot,
    // Keys keep the selection clear of a fade, and of a phone's island, under which the foot's fade
    // lies.
    scrollPaddingBlock: `${scrollFade.depth} max(${scrollFade.depth}, ${tm.listFoot})`,
    outline: 'none',
    // The list fades into its sheet at an end it can still scroll toward. The mask is the fade's
    // inverse over the padding box, cut from a solid one over the whole, so the scrollbar's gutter
    // beside the padding box stays whole. A browser that can't drive the fade by scrolling shows none.
    mask: {
      default: null,
      [SCROLL_DRIVEN]: `linear-gradient(#000, transparent ${scrollFades.start}, transparent calc(100% - ${scrollFades.end}), #000) padding-box exclude, linear-gradient(#000, #000)`,
    },
    animationName: { default: null, [SCROLL_DRIVEN]: `${fadeStart}, ${fadeEnd}` },
    animationFillMode: 'both',
    animationTimeline: 'scroll(self)',
    animationRange: `0px ${scrollFade.reveal}, calc(100% - ${scrollFade.reveal}) 100%`,
  },
  canvas: (height: number) => ({ position: 'relative', height }),
  // Skeleton rows stand where the scroller would place the first rows, and scroll nowhere. They stand
  // for a list that runs on below, so their foot fades as its will.
  skeletons: {
    height: '100%',
    overflow: 'hidden',
    paddingBlockStart: RING,
    paddingInline: spacingVars['--spacing-1-5'],
    maskImage: {
      default: null,
      [SCROLL_DRIVEN]: `linear-gradient(#000 calc(100% - ${scrollFade.depth}), transparent)`,
    },
  },
  standing: {
    position: 'relative',
  },
  pending: {
    cursor: 'default',
    backgroundColor: 'transparent',
  },
  grow: {
    flexGrow: 1,
  },
  row: {
    position: 'absolute',
    insetInline: 0,
    display: 'grid',
    gridTemplateColumns: 'auto minmax(0, 1fr)',
    gap: spacingVars['--spacing-2'],
    paddingBlock: tm.rowPad,
    paddingInlineStart: spacingVars['--spacing-1-5'],
    paddingInlineEnd: spacingVars['--spacing-2'],
    borderRadius: radiusVars['--radius-element'],
    overflow: 'hidden',
    cursor: 'pointer',
    // A row is picked, not read: Shift extends the selection rather than selecting text, and a long
    // press picks it rather than opening a phone's callout.
    userSelect: 'none',
    WebkitTouchCallout: 'none',
    // Vertical moves scroll the list, and sideways ones reach the row as a swipe.
    touchAction: 'pan-y',
    // Sender and subject lead in ink, read or not. Weight and the dot say which is unread, and the
    // time and preview recede into the quiet tone.
    color: colorVars['--color-text-primary'],
    fontSize: typeScaleVars['--text-body-size'],
    lineHeight: typeScaleVars['--text-body-leading'],
    backgroundColor: {
      default: 'transparent',
      ':hover': { default: null, '@media (hover: hover)': colorVars['--color-overlay-hover'] },
    },
  },
  placed: (top: number) => ({ transform: `translate(var(${SWIPE}, 0px), ${top}px)` }),
  ruler: {
    visibility: 'hidden',
    pointerEvents: 'none',
  },
  // Selection lifts instead of tinting: the open conversation rises from the sheet onto paper.
  selected: {
    backgroundColor: {
      default: colorVars['--color-background-card'],
      ':hover': colorVars['--color-background-card'],
      [media.forcedColors]: 'Highlight',
    },
    boxShadow: `0 0 0 1px ${colorVars['--color-border']}, 0 6px 16px -10px ${tm.shade}`,
    color: { default: null, [media.forcedColors]: 'HighlightText' },
    forcedColorAdjust: 'none',
  },
  // The keyboard's active descendant gets the same focus ring as the folder tree's focused line.
  keyboardFocused: {
    outline: {
      default: `${focusVars['--focus-outline-width']} ${focusVars['--focus-outline-style']} ${focusVars['--focus-outline-color']}`,
      [media.forcedColors]: '2px solid Highlight',
    },
    outlineOffset: '-2px',
  },
  // The sender's avatar leads the row from its top. Under a finger it's a 44-pixel target, reaching
  // past its 32 pixels without moving anything around it.
  avatar: {
    display: 'grid',
    placeItems: 'center',
    alignSelf: 'start',
    width: { default: '32px', [media.coarse]: '44px' },
    height: { default: '32px', [media.coarse]: '44px' },
    margin: { default: 0, [media.coarse]: '-6px' },
  },
  lines: {
    display: 'flex',
    flexDirection: 'column',
    minWidth: 0,
  },
  top: {
    display: 'flex',
    alignItems: 'center',
    gap: spacingVars['--spacing-1-5'],
    minWidth: 0,
  },
  dot: {
    flexShrink: 0,
    width: '7px',
    height: '7px',
    borderRadius: '50%',
    backgroundColor: { default: colorVars['--color-accent'], [media.forcedColors]: 'CanvasText' },
  },
  sender: {
    fontWeight: fontWeightVars['--font-weight-medium'],
  },
  senderUnread: {
    fontWeight: fontWeightVars['--font-weight-semibold'],
  },
  subjectUnread: {
    fontWeight: fontWeightVars['--font-weight-medium'],
  },
  // Each of a row's lines is one line of its type tall, empty or not, and a taller glyph, such as
  // an emoji's, can't make it more.
  line: {
    height: '1lh',
  },
  clip: {
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  time: {
    flexShrink: 0,
    marginInlineStart: 'auto',
    color: tm.textQuiet,
    fontSize: typeScaleVars['--text-supporting-size'],
  },
  preview: {
    color: tm.textQuiet,
    fontSize: typeScaleVars['--text-supporting-size'],
  },
  flag: {
    flexShrink: 0,
    color: tm.highlight,
    fill: tm.highlight,
  },
  quiet: {
    flexShrink: 0,
    color: tm.textQuiet,
  },
  // A draft addressed to nobody yet says so in the row's muted ink.
  nobody: {
    color: tm.textQuiet,
  },
  // A bundle's owner, and a thread's number, recede beside the repository and the title.
  owner: {
    color: tm.textQuiet,
    fontWeight: fontWeightVars['--font-weight-normal'],
  },
  commit: {
    fontFamily: typographyVars['--font-family-code'],
    fontSize: '0.86em',
  },
  chipLine: {
    display: 'flex',
    alignItems: 'center',
    minWidth: 0,
  },
});

const swiping = stylex.create({
  // A row being swiped rises off the sheet, as a selected one does.
  lifted: {
    backgroundColor: colorVars['--color-background-card'],
    boxShadow: `0 0 0 1px ${colorVars['--color-border']}, 0 6px 16px -10px ${tm.shade}`,
  },
  settling: {
    transitionProperty: 'transform',
    transitionDuration: { default: durationVars['--duration-fast'], [media.reducedMotion]: '0s' },
  },
});
