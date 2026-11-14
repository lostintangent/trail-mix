import { Icon } from '@astryxdesign/core/Icon';
import { Skeleton } from '@astryxdesign/core/Skeleton';
import {
  colorVars,
  focusVars,
  fontWeightVars,
  radiusVars,
  spacingVars,
  typeScaleVars,
  typographyVars,
} from '@astryxdesign/core/theme/tokens.stylex';
import { VisuallyHidden } from '@astryxdesign/core/VisuallyHidden';
import * as stylex from '@stylexjs/stylex';
import { Paperclip, Star } from 'lucide-react';
import { memo, useEffect, useRef, type MouseEvent, type PointerEvent, type RefObject } from 'react';
import { pendingStyles, TextSkeleton } from '../../../app/theme/Pending.tsx';
import { SenderAvatar } from '../../../app/theme/SenderAvatar.tsx';
import { media, tm } from '../../../app/theme/tokens.stylex.ts';
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
import type { SelectBy } from '../core/selection.ts';
import { formatListDate } from './dates.ts';
import { BundleChips } from './github.tsx';
import { Marked } from './search.tsx';
import { SWIPE, useTouch } from './useTouch.ts';

/**
 * One conversation, or a bundle. Memoized, so moving the selection redraws only the two rows it
 * touches.
 */
export const ConversationRow = memo(function ConversationRow({
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
 * An empty row, out of sight, that the list measures for every row's height. Each of a row's three
 * lines is exactly one line of its type tall, whatever it holds or leaves empty, so the height
 * follows from the row's type and padding alone. No row's content can change it, while a coarse
 * pointer's padding or a larger text size changes it for every row at once.
 */
export function RowRuler({ ref }: { ref: RefObject<HTMLDivElement | null> }) {
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
 * A row on its way, in the shape of a conversation's, its lines of lengths that differ from row to
 * row. Given its place, it lies where the row will, and shows only once late, while assistive
 * technology hears the list is busy instead. Without one, it stands in a list on its way.
 */
export function RowSkeleton({ row, top }: { row: number; top?: number }) {
  const width = (widths: readonly string[]) => widths[row % widths.length] ?? '50%';
  const place = top === undefined ? styles.standing : [styles.placed(top), pendingStyles.late];
  return (
    <div aria-hidden {...stylex.props(styles.row, styles.pending, place)}>
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

/** Lines of differing lengths, as mail has. */
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

const styles = stylex.create({
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
  // Each of a row's lines is one line of its type tall, empty or not, and a taller glyph, such as
  // an emoji's, can't make it more.
  line: {
    height: '1lh',
  },
  sender: {
    fontWeight: fontWeightVars['--font-weight-medium'],
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
  dot: {
    flexShrink: 0,
    width: '7px',
    height: '7px',
    borderRadius: '50%',
    backgroundColor: { default: colorVars['--color-accent'], [media.forcedColors]: 'CanvasText' },
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
});
