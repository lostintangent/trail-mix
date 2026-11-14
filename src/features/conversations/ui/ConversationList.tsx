import { spacingVars } from '@astryxdesign/core/theme/tokens.stylex';
import * as stylex from '@stylexjs/stylex';
import {
  defaultRangeExtractor,
  observeElementOffset,
  useVirtualizer,
} from '@tanstack/react-virtual';
import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  useMemo,
  type KeyboardEvent,
  type RefObject,
} from 'react';
import { Pending } from '../../../app/theme/Pending.tsx';
import { scrollFade, scrollFades, tm } from '../../../app/theme/tokens.stylex.ts';
import type { ConversationId, ListItem, Marks, StampColor } from '../../mail/core/index.ts';
import type { Listed } from '../core/pages.ts';
import type { SelectBy, Selection } from '../core/selection.ts';
import { ConversationRow, RowRuler, RowSkeleton } from './ConversationRow.tsx';

/** A row's height before the list is first laid out: three lines of text and the row's padding. */
const FIRST_GUESS = 72;

/**
 * A lifted row's ring, a selection's or a swipe's, lies a pixel outside it. A list of rows keeps
 * that pixel at both its ends, and beside a row it scrolls to, so its scroller never clips the ring.
 */
const RING = 1;

/** How many rows beyond those in sight the list says it shows, so their pages arrive in time. */
const AHEAD = 30;

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
            <ConversationRow
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
 * A list on its way: rows in the shape of its conversations, each one row's height, as the ruler
 * measures it, so the first page lands where they stood.
 */
export function ConversationListSkeleton({ label }: { label: string }) {
  return (
    <Pending label={`Loading ${label}`} xstyle={styles.skeletons} holdsPlace={false}>
      {Array.from({ length: SKELETON_ROWS }, (_, row) => (
        <RowSkeleton key={row} row={row} />
      ))}
    </Pending>
  );
}

/** Enough rows to fill a tall window. */
const SKELETON_ROWS = 16;

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
});
