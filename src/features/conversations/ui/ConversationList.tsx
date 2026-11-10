import { Icon } from '@astryxdesign/core/Icon';
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
import { stampStyles } from '../../../app/theme/stamps.ts';
import { media, tm } from '../../../app/theme/tokens.stylex.ts';
import type { ConversationId, ConversationSummary, StampColor } from '../../mail/core/index.ts';
import type { SelectBy, Selection } from '../core/selection.ts';
import { formatListDate } from './dates.ts';

/** A row's height before one has been drawn: three lines of text and the row's padding. */
const FIRST_GUESS = 72;

/** How many rows short of the end the list asks for more, so the next page arrives in time. */
const AHEAD = 30;

/** How long a finger rests on a row before it starts picking, and how far it may drift meanwhile. */
const LONG_PRESS_MS = 500;
const LONG_PRESS_SLOP = 10;

/** How far left, as a share of its width, a finger swipes a row before letting go archives it. */
const SWIPE_SHARE = 0.4;

/**
 * The conversations of a view, newest first, drawn only where the list is scrolled to. Selected
 * conversations lift from the sheet onto paper. The list takes focus as one control and moves its
 * selection with the arrow keys, Home, End and the page keys, and Shift extends it. A click selects
 * one, Cmd or Ctrl adds or removes one, and Shift selects the range from the last pick. A finger held
 * on a row starts picking, and while picking, a tap adds or removes. A finger that swipes a row far
 * enough to the left archives it. The sheet the list lies on draws
 * its focus ring, so the list carries StyleX's default marker for
 * `stylex.when.descendant(':focus-visible')`.
 */
export function ConversationList({
  label,
  conversations,
  stamps,
  selection,
  isPicking = false,
  onSelect,
  onLongPress,
  onSwipe,
  onNearEnd,
}: {
  label: string;
  conversations: readonly ConversationSummary[];
  /** Each account's stamp color, by account id. */
  stamps: ReadonlyMap<string, StampColor>;
  selection: Selection;
  /** Whether a tap adds a row to the selection, as after a long press, instead of opening it. */
  isPicking?: boolean;
  onSelect: (id: ConversationId, by: SelectBy) => void;
  onLongPress?: (id: ConversationId) => void;
  onSwipe?: (id: ConversationId) => void;
  /** Called while the rows drawn come within reach of the end. */
  onNearEnd: () => void;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const listId = useId();
  const rowHeight = useRowHeight(scroller);
  // The row the keys move from and the list names as active: the last one picked.
  const selectedIndex = conversations.findIndex(({ id }) => id === selection.anchor);
  const selected = useMemo(() => new Set(selection.ids), [selection.ids]);
  const reportOffset = useRef<(offset: number, isScrolling: boolean) => void>(null);
  const virtualizer = useVirtualizer({
    count: conversations.length,
    getScrollElement: () => scroller.current,
    observeElementOffset: (instance, report) => {
      reportOffset.current = report;
      return observeElementOffset(instance, report);
    },
    estimateSize: () => rowHeight,
    getItemKey: (index) => conversations[index]?.id ?? index,
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
  const lastDrawn = virtualizer.getVirtualItems().at(-1)?.index ?? -1;
  useEffect(() => {
    if (lastDrawn >= conversations.length - AHEAD) onNearEnd();
  }, [lastDrawn, conversations.length, onNearEnd]);
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
    const target = to === undefined ? undefined : conversations[to];
    if (to === undefined || !target) return;
    event.preventDefault();
    onSelect(target.id, event.shiftKey ? 'extend' : 'only');
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
      tabIndex={0}
      onKeyDown={move}
      {...stylex.props(styles.scroller, stylex.defaultMarker())}
    >
      <div {...stylex.props(styles.canvas(virtualizer.getTotalSize()))}>
        {virtualizer.getVirtualItems().map(({ index, start }) => {
          const conversation = conversations[index];
          if (!conversation) return null;
          return (
            <Row
              key={conversation.id}
              id={optionId(index)}
              conversation={conversation}
              stamp={stamps.get(conversation.account) ?? 'slate'}
              top={start}
              position={index + 1}
              size={conversations.length}
              isSelected={selected.has(conversation.id)}
              isPicking={isPicking}
              onSelect={onSelect}
              onLongPress={onLongPress}
              onSwipe={onSwipe}
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
  stamp,
  top,
  position,
  size,
  isSelected,
  isPicking,
  onSelect,
  onLongPress,
  onSwipe,
}: {
  id: string;
  conversation: ConversationSummary;
  stamp: StampColor;
  top: number;
  position: number;
  size: number;
  isSelected: boolean;
  isPicking: boolean;
  onSelect: (id: ConversationId, by: SelectBy) => void;
  onLongPress: ((id: ConversationId) => void) | undefined;
  onSwipe: ((id: ConversationId) => void) | undefined;
}) {
  const { subject, senders, preview, date, unread, flagged, hasAttachments } = conversation;
  const isUnread = unread > 0;
  const touch = useTouch(
    () => onLongPress?.(conversation.id),
    onSwipe && (() => onSwipe(conversation.id)),
  );
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
      {...stylex.props(
        styles.row,
        styles.placed(top),
        isUnread && styles.unread,
        isSelected && styles.selected,
      )}
    >
      <span {...stylex.props(styles.stamp, stampStyles[stamp])} />
      <span {...stylex.props(styles.lines)}>
        <span {...stylex.props(styles.top)}>
          {isUnread && <span {...stylex.props(styles.dot)} />}
          <span {...stylex.props(styles.sender, isUnread && styles.senderUnread, styles.clip)}>
            {senderNames(senders)}
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
        <span {...stylex.props(isUnread && styles.subjectUnread, styles.clip)}>
          {subject || '(no subject)'}
        </span>
        <span {...stylex.props(styles.preview, styles.clip)}>{preview}</span>
      </span>
    </div>
  );
});

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
 * Every row is the same height, three lines of text and the row's padding, so the list places rows
 * by arithmetic. It watches one drawn row for that height, as when a finger makes the text and
 * padding larger, and moves to another only when that row is no longer drawn. So a render neither
 * measures nor, when the height stays the same, asks for another render. The height is rounded up
 * to a whole pixel, so rows start on whole pixels and a scroll lands exactly where it was asked to.
 */
function useRowHeight(scroller: RefObject<HTMLDivElement | null>): number {
  const [height, setHeight] = useState(FIRST_GUESS);
  const watch = useRef<(row: Element | null) => void>(null);
  useLayoutEffect(() => {
    let measured = FIRST_GUESS;
    let watched: Element | null = null;
    const observer = new ResizeObserver(([entry]) => {
      const size = entry?.borderBoxSize[0]?.blockSize;
      if (size === undefined) return;
      const next = Math.ceil(size);
      if (next === measured) return;
      measured = next;
      setHeight(next);
    });
    watch.current = (row) => {
      if (row === watched) return;
      if (watched) observer.unobserve(watched);
      if (row) observer.observe(row);
      watched = row;
    };
    return () => {
      observer.disconnect();
      watch.current = null;
    };
  }, []);
  useLayoutEffect(() => {
    watch.current?.(scroller.current?.querySelector('[role="option"]') ?? null);
  });
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
    color: colorVars['--color-text-secondary'],
    fontSize: typeScaleVars['--text-body-size'],
    lineHeight: typeScaleVars['--text-body-leading'],
    backgroundColor: {
      default: 'transparent',
      ':hover': { default: null, '@media (hover: hover)': colorVars['--color-overlay-hover'] },
    },
  },
  placed: (top: number) => ({ transform: `translate(var(${SWIPE}, 0px), ${top}px)` }),
  unread: {
    color: colorVars['--color-text-primary'],
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
