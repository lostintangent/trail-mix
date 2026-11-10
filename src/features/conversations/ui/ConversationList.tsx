import { Icon } from '@astryxdesign/core/Icon';
import {
  colorVars,
  fontWeightVars,
  radiusVars,
  spacingVars,
  typeScaleVars,
} from '@astryxdesign/core/theme/tokens.stylex';
import { VisuallyHidden } from '@astryxdesign/core/VisuallyHidden';
import * as stylex from '@stylexjs/stylex';
import { defaultRangeExtractor, useVirtualizer } from '@tanstack/react-virtual';
import { Paperclip, Star } from 'lucide-react';
import {
  memo,
  useCallback,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type RefObject,
} from 'react';
import { stampStyles } from '../../../app/theme/stamps.ts';
import { media, tm } from '../../../app/theme/tokens.stylex.ts';
import type { ConversationId, ConversationSummary, StampColor } from '../../mail/core/index.ts';
import { formatListDate } from './dates.ts';

/** A row's height before one has been drawn: three lines of text and the row's padding. */
const FIRST_GUESS = 72;

/**
 * The conversations of a view, newest first, drawn only where the list is scrolled to. The selected
 * conversation lifts from the sheet onto paper. The list takes focus as one control and moves its
 * selection with the arrow keys, Home, End and the page keys.
 */
export function ConversationList({
  label,
  conversations,
  stamps,
  selected,
  onSelect,
}: {
  label: string;
  conversations: readonly ConversationSummary[];
  /** Each account's stamp color, by account id. */
  stamps: ReadonlyMap<string, StampColor>;
  selected: ConversationId | undefined;
  onSelect: (id: ConversationId) => void;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const listId = useId();
  const rowHeight = useRowHeight(scroller);
  const selectedIndex = conversations.findIndex(({ id }) => id === selected);
  const virtualizer = useVirtualizer({
    count: conversations.length,
    getScrollElement: () => scroller.current,
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
    virtualizer.scrollToIndex(to, { align: 'auto' });
    onSelect(target.id);
  };

  return (
    <div
      ref={scroller}
      role="listbox"
      aria-label={label}
      aria-activedescendant={selectedIndex < 0 ? undefined : optionId(selectedIndex)}
      tabIndex={0}
      onKeyDown={move}
      {...stylex.props(styles.scroller)}
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
              isSelected={conversation.id === selected}
              onSelect={onSelect}
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
  onSelect,
}: {
  id: string;
  conversation: ConversationSummary;
  stamp: StampColor;
  top: number;
  position: number;
  size: number;
  isSelected: boolean;
  onSelect: (id: ConversationId) => void;
}) {
  const { subject, senders, preview, date, unread, flagged, hasAttachments } = conversation;
  const isUnread = unread > 0;
  const select = useCallback(() => onSelect(conversation.id), [onSelect, conversation.id]);
  return (
    <div
      id={id}
      role="option"
      aria-selected={isSelected}
      aria-posinset={position}
      aria-setsize={size}
      onClick={select}
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
 * Every row is the same height, three lines of text and the row's padding, so the list places rows
 * by arithmetic. It measures one drawn row for that height, and again whenever the row changes
 * size, as when a finger makes the text and padding larger.
 */
function useRowHeight(scroller: RefObject<HTMLDivElement | null>): number {
  const [height, setHeight] = useState(FIRST_GUESS);
  useLayoutEffect(() => {
    const row = scroller.current?.querySelector('[role="option"]');
    if (!row) return;
    const observer = new ResizeObserver(() => setHeight(row.getBoundingClientRect().height));
    observer.observe(row);
    return () => observer.disconnect();
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
    outline: {
      default: 'none',
      ':focus-visible': `2px solid ${colorVars['--color-accent']}`,
    },
    outlineOffset: '-2px',
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
    color: colorVars['--color-text-secondary'],
    fontSize: typeScaleVars['--text-body-size'],
    lineHeight: typeScaleVars['--text-body-leading'],
    backgroundColor: {
      default: 'transparent',
      ':hover': { default: null, '@media (hover: hover)': colorVars['--color-overlay-hover'] },
    },
  },
  placed: (top: number) => ({ transform: `translateY(${top}px)` }),
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
