import { Icon } from '@astryxdesign/core/Icon';
import { Skeleton } from '@astryxdesign/core/Skeleton';
import {
  colorVars,
  durationVars,
  fontWeightVars,
  radiusVars,
  spacingVars,
  typeScaleVars,
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
import { stampStyles } from '../../../app/theme/stamps.ts';
import { media, tm } from '../../../app/theme/tokens.stylex.ts';
import type {
  ConversationId,
  ConversationSummary,
  Marks,
  StampColor,
} from '../../mail/core/index.ts';
import type { Listed } from '../core/pages.ts';
import type { SelectBy, Selection } from '../core/selection.ts';
import { formatListDate } from './dates.ts';
import { Marked } from './search.tsx';

/** A list that shows no search. */
const NO_MARKS: Marks = [];

/** A row's height before the list is first laid out: three lines of text and the row's padding. */
const FIRST_GUESS = 72;

/** How many rows beyond those in sight the list says it shows, so their pages arrive in time. */
const AHEAD = 30;

/** How long a finger rests on a row before it starts picking, and how far it may drift meanwhile. */
const LONG_PRESS_MS = 500;
const LONG_PRESS_SLOP = 10;

/** How far left, as a share of its width, a finger swipes a row before letting go archives it. */
const SWIPE_SHARE = 0.4;

/**
 * The conversations of a view, newest first, drawn only where the list is scrolled to. The list is
 * as long as the view, and a row whose page hasn't arrived stands as a skeleton until it has. Rows
 * arriving or leaving above the top row in sight leave it where it is, so mail that arrives while
 * the list is scrolled down moves nothing, while at the top it shows. Selected conversations lift
 * from the sheet onto paper. The list takes focus as one control and moves its selection with the
 * arrow keys, Home, End and the page keys, and Shift extends it. A key that lands on a row still on
 * its way selects it once it arrives. A click selects one, Cmd or Ctrl adds or removes one, and
 * Shift selects the range from the last pick. A finger held on a row starts picking, and while
 * picking, a tap adds or removes. A finger that swipes a row far enough to the left archives it.
 * The sheet the list lies on draws its focus ring, so the list carries StyleX's default marker for
 * `stylex.when.descendant(':focus-visible')`.
 */
export function ConversationList({
  label,
  listKey,
  conversations,
  marks = NO_MARKS,
  isUpdating = false,
  stamps,
  selection,
  isPicking = false,
  onSelect,
  onLongPress,
  onSwipe,
  onAhead,
  onShown,
}: {
  label: string;
  /** Names the list shown. Another list starts at its top. */
  listKey: string;
  /** Every conversation in the list, with those whose page hasn't arrived yet empty. */
  conversations: Listed<ConversationSummary>;
  /** What a search matched, marked in each row. The same while the search stays the same. */
  marks?: Marks;
  /** Whether newer rows are on their way, as while a search is typed. */
  isUpdating?: boolean;
  /** Each account's stamp color, by account id. */
  stamps: ReadonlyMap<string, StampColor>;
  selection: Selection;
  /** Whether a tap adds a row to the selection, as after a long press, instead of opening it. */
  isPicking?: boolean;
  onSelect: (id: ConversationId, by: SelectBy) => void;
  onLongPress?: (id: ConversationId) => void;
  onSwipe?: (id: ConversationId) => void;
  /**
   * Called as a conversation is about to be opened, ahead of the click: once the pointer rests on
   * its row, and again with `isPressed` as a mouse or pen presses it. The same function each render.
   */
  onAhead?: (id: ConversationId, isPressed: boolean) => void;
  /**
   * Says which rows the list shows: from the first to the last in sight, with some to spare either
   * side, and the selected one, which stays drawn out of sight.
   */
  onShown: (first: number, last: number, selected: number) => void;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const ruler = useRef<HTMLDivElement>(null);
  const listId = useId();
  const rowHeight = useRowHeight(ruler);
  // The row the keys move from and the list names as active: the last one picked.
  const selectedIndex = useMemo(() => {
    const { anchor } = selection;
    return anchor === undefined ? -1 : conversations.findIndex((row) => row?.id === anchor);
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
    rows: Listed<ConversationSummary>;
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
  // A selection moved from elsewhere, as by J and K, scrolls into view. The list's own keys scroll as
  // they move, in the same commit, so they're left alone here.
  const isMovedHere = useRef(false);
  useLayoutEffect(() => {
    if (isMovedHere.current) isMovedHere.current = false;
    else if (selectedIndex >= 0) virtualizer.scrollToIndex(selectedIndex, { align: 'auto' });
  }, [virtualizer, selectedIndex]);
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
  }, [selection.anchor]);
  useLayoutEffect(() => {
    const row = awaited.current && conversations[awaited.current.index];
    if (!row || !awaited.current) return;
    const { by } = awaited.current;
    awaited.current = undefined;
    onSelect(row.id, by);
  }, [conversations, onSelect]);
  const optionId = (index: number) => `${listId}-${index}`;

  const move = (event: KeyboardEvent<HTMLDivElement>) => {
    const page = Math.max(1, Math.floor((scroller.current?.clientHeight ?? 0) / rowHeight) - 1);
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
      {...stylex.props(styles.scroller, stylex.defaultMarker())}
    >
      <RowRuler ref={ruler} />
      <div {...stylex.props(styles.canvas(virtualizer.getTotalSize()))}>
        {drawn.map(({ index, start }) => {
          const conversation = conversations[index];
          if (!conversation)
            return <RowSkeleton key={`pending ${index}`} row={index} top={start} />;
          return (
            <Row
              key={conversation.id}
              id={optionId(index)}
              conversation={conversation}
              marks={marks}
              stamp={stamps.get(conversation.account) ?? 'slate'}
              top={start}
              position={index + 1}
              size={conversations.length}
              isSelected={selected.has(conversation.id)}
              isPicking={isPicking}
              onSelect={onSelect}
              onLongPress={onLongPress}
              onSwipe={onSwipe}
              onAhead={onAhead}
            />
          );
        })}
      </div>
    </div>
  );
}

/** One conversation. Memoized, so moving the selection redraws only the two rows it touches. */
const Row = memo(function Row({
  id,
  conversation,
  marks,
  stamp,
  top,
  position,
  size,
  isSelected,
  isPicking,
  onSelect,
  onLongPress,
  onSwipe,
  onAhead,
}: {
  id: string;
  conversation: ConversationSummary;
  marks: Marks;
  stamp: StampColor;
  top: number;
  position: number;
  size: number;
  isSelected: boolean;
  isPicking: boolean;
  onSelect: (id: ConversationId, by: SelectBy) => void;
  onLongPress: ((id: ConversationId) => void) | undefined;
  onSwipe: ((id: ConversationId) => void) | undefined;
  onAhead: ((id: ConversationId, isPressed: boolean) => void) | undefined;
}) {
  const { subject, senders, preview, date, unread, flagged, hasAttachments } = conversation;
  const isUnread = unread > 0;
  const touch = useTouch(
    () => onLongPress?.(conversation.id),
    onSwipe && (() => onSwipe(conversation.id)),
  );
  const ahead = useAhead((isPressed) => onAhead?.(conversation.id, isPressed));
  const select = (event: MouseEvent) => {
    if (touch.tookClick()) return;
    const by: SelectBy = event.shiftKey
      ? 'extend'
      : event.metaKey || event.ctrlKey || isPicking
        ? 'toggle'
        : 'only';
    onSelect(conversation.id, by);
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
      {...stylex.props(styles.row, styles.placed(top), isSelected && styles.selected)}
    >
      <span {...stylex.props(styles.stamp, stampStyles[stamp])} />
      <span {...stylex.props(styles.lines)}>
        <span {...stylex.props(styles.top, styles.line)}>
          {isUnread && <span {...stylex.props(styles.dot)} />}
          <span {...stylex.props(styles.sender, isUnread && styles.senderUnread, styles.clip)}>
            <Marked text={senderNames(senders)} marks={marks} />
          </span>
          {isUnread && <VisuallyHidden>Unread</VisuallyHidden>}
          {flagged && <Icon icon={Star} size="xsm" label="Flagged" xstyle={styles.flag} />}
          {hasAttachments && (
            <Icon icon={Paperclip} size="xsm" label="Has attachments" xstyle={styles.quiet} />
          )}
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
    </div>
  );
});

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
      <Skeleton width="3px" radius="none" index={row} xstyle={styles.stamp} />
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
function useTouch(onLongPress: () => void, onSwipe: (() => void) | undefined) {
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
    if (canArchive && at.x - event.clientX > at.row.offsetWidth * SWIPE_SHARE) onSwipe?.();
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
          if (!onSwipe || Math.abs(dx) <= Math.abs(dy) || dx > 0) return end();
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
      <span />
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

/** "Ada Park" for one sender, and first names for several, newest first. */
function senderNames(senders: readonly { name?: string; email: string }[]): string {
  const names = senders.map(({ name, email }) => name || email);
  if (names.length <= 1) return names[0] ?? '';
  return names.map((name) => name.split(' ')[0]).join(', ');
}

const styles = stylex.create({
  scroller: {
    position: 'relative',
    height: '100%',
    overflowY: 'auto',
    overscrollBehavior: 'contain',
    paddingInline: spacingVars['--spacing-1-5'],
    outline: 'none',
  },
  canvas: (height: number) => ({ position: 'relative', height }),
  // Skeleton rows stand where the scroller would place the first rows, and scroll nowhere.
  skeletons: {
    height: '100%',
    overflow: 'hidden',
    paddingInline: spacingVars['--spacing-1-5'],
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
    gridTemplateColumns: '3px minmax(0, 1fr)',
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
  stamp: {
    borderRadius: '2px',
    forcedColorAdjust: 'none',
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
