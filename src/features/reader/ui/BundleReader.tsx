import { Icon } from '@astryxdesign/core/Icon';
import { IconButton } from '@astryxdesign/core/IconButton';
import {
  colorVars,
  focusVars,
  fontWeightVars,
  spacingVars,
  typeScaleVars,
  typographyVars,
} from '@astryxdesign/core/theme/tokens.stylex';
import * as stylex from '@stylexjs/stylex';
import { ExternalLink } from 'lucide-react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useEffect, useLayoutEffect, useRef } from 'react';
import { pendingStyles } from '../../../app/theme/Pending.tsx';
import { media, tm } from '../../../app/theme/tokens.stylex.ts';
import {
  Chip,
  factsOf,
  formatListDate,
  kindIconOf,
  numberOf,
  type Listed,
} from '../../conversations/index.ts';
import {
  repositoryAddressOf,
  threadAddressOf,
  type Account,
  type BundleSummary,
  type ConversationId,
  type ConversationSummary,
} from '../../mail/core/index.ts';
import { issueStyles, threadStyles } from './layout.ts';
import { counted, MetaLine } from './meta.tsx';
import { ThreadSkeleton } from './skeletons.tsx';

type BundleReaderProps = {
  bundle: BundleSummary;
  /** Its threads, newest first, at their true count, with the places of those on their way empty. */
  threads: Listed<ConversationSummary>;
  account: Account | undefined;
  /** The name of the folder its threads lie in, its account's Inbox. */
  folder: string;
  /** What the reader scrolls, which the threads are drawn in as they come into sight. */
  scroller: HTMLElement | null;
  /** Opens a thread in the reader, in the bundle's place. */
  onOpen: (id: ConversationId) => void;
  /** Says which threads are in sight, so the pages they lie on are fetched. */
  onShown: (first: number, last: number, selected: number) => void;
  /** The place of the thread the member came back from, which the bundle opens with in sight. */
  from?: number;
};

/**
 * A guess at how tall the bundle's head and each thread's sheet stand, with the gap below each,
 * until it is drawn and measured.
 */
const HEAD_HEIGHT = 96;
const SHEET_HEIGHT = 120;

/** How many threads beyond those in sight are drawn and fetched, so a scroll finds them there. */
const AHEAD = 4;

/**
 * A bundle in the reader: its repository set as a conversation's subject is, the line under it, and
 * a sheet of paper for each thread. A thread's title opens it in the reader, and its arrow opens it
 * on GitHub, so both reach Tab and a finger. A bundle may hold thousands of threads, so only the
 * sheets in sight are drawn, and only their pages fetched, as the list does with its rows. A sheet
 * whose page is on its way stands as a skeleton.
 */
export function BundleReader({
  bundle,
  threads,
  account,
  folder,
  scroller,
  onOpen,
  onShown,
  from,
}: BundleReaderProps) {
  // The bundle's head is the first place, so it scrolls away with the sheets under it.
  const virtualizer = useVirtualizer({
    count: threads.length + 1,
    getScrollElement: () => scroller,
    estimateSize: (place) => (place === 0 ? HEAD_HEIGHT : SHEET_HEIGHT),
    getItemKey: (place) => (place === 0 ? 'head' : (threads[place - 1]?.id ?? place)),
    overscan: AHEAD,
  });
  const cameFrom = useRef(from);
  useLayoutEffect(() => {
    if (scroller && cameFrom.current !== undefined) {
      virtualizer.scrollToIndex(cameFrom.current + 1, { align: 'center' });
      cameFrom.current = undefined;
    }
  }, [scroller, virtualizer]);
  const inSight = virtualizer.range;
  const first = Math.max(0, (inSight?.startIndex ?? 0) - 1 - AHEAD);
  const last = (inSight?.endIndex ?? 0) - 1 + AHEAD;
  useEffect(() => {
    onShown(first, last, -1);
  }, [first, last, onShown]);
  return (
    <div {...stylex.props(threadStyles.thread)}>
      <div {...stylex.props(styles.places(virtualizer.getTotalSize()))}>
        {virtualizer.getVirtualItems().map(({ index, key, start }) => {
          const thread = threads[index - 1];
          return (
            <div
              key={key}
              data-index={index}
              ref={virtualizer.measureElement}
              {...stylex.props(
                styles.place,
                styles.placed(start),
                index > 0 && !thread && pendingStyles.late,
              )}
            >
              {index === 0 ? (
                <Head bundle={bundle} account={account} folder={folder} />
              ) : thread ? (
                <ThreadSheet thread={thread} onOpen={onOpen} />
              ) : (
                <ThreadSkeleton place={index - 1} />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** The bundle's repository, set as a conversation's subject is, and the line under it. */
function Head({
  bundle,
  account,
  folder,
}: Pick<BundleReaderProps, 'bundle' | 'account' | 'folder'>) {
  const { repository, count } = bundle;
  const slash = repository.indexOf('/') + 1;
  const address = repositoryAddressOf(repository);
  return (
    <div {...stylex.props(threadStyles.stack)}>
      <h1 {...stylex.props(threadStyles.subject)}>
        <span {...stylex.props(styles.quiet)}>{repository.slice(0, slash)}</span>
        {repository.slice(slash)}
      </h1>
      <MetaLine
        account={account}
        says={[
          ...(account ? [account.name] : []),
          folder,
          counted(bundle.threads, 'thread'),
          counted(count, 'message'),
        ]}
        onGitHub={address ? { address, name: repository.slice(slash) } : undefined}
      />
    </div>
  );
}

/**
 * One thread of a bundle, as a sheet: its kind, title and number, when it last spoke, why GitHub
 * wrote, how many messages it holds, and what its newest says. The whole sheet opens it.
 */
function ThreadSheet({
  thread,
  onOpen,
}: {
  thread: ConversationSummary;
  onOpen: (id: ConversationId) => void;
}) {
  const { id, github, subject, date, unread, count, senders, preview } = thread;
  const isUnread = unread > 0;
  const number = github && numberOf(github);
  const address = github && threadAddressOf(github);
  const newest = senders[0];
  return (
    <article {...stylex.props(issueStyles.sheet, styles.sheet)}>
      {github ? <Icon icon={kindIconOf(github)} xstyle={styles.kind} /> : <span />}
      <div {...stylex.props(issueStyles.head, styles.head)}>
        <button
          type="button"
          onClick={() => onOpen(id)}
          {...stylex.props(issueStyles.title, styles.title, isUnread && styles.unread)}
        >
          {isUnread && <span aria-label="Unread" role="img" {...stylex.props(styles.dot)} />}
          {github?.title ?? subject}
          {number && (
            <>
              {' '}
              <span {...stylex.props(styles.number, number.isCommit && styles.commit)}>
                {number.text}
              </span>
            </>
          )}
        </button>
        <time dateTime={date} {...stylex.props(styles.time)}>
          {formatListDate(date)}
        </time>
      </div>
      <div {...stylex.props(issueStyles.under, issueStyles.facts, styles.facts)}>
        {github && factsOf(github, isUnread).map((fact) => <Chip key={fact.label} fact={fact} />)}
        <span {...stylex.props(styles.count)}>{counted(count, 'message')}</span>
      </div>
      <p {...stylex.props(issueStyles.under, issueStyles.act, styles.act)}>
        {newest?.name && <b {...stylex.props(styles.actor)}>{newest.name} </b>}
        {preview}
      </p>
      {address && (
        <IconButton
          label={`Open ${number?.text ?? 'it'} on GitHub`}
          icon={<Icon icon={ExternalLink} />}
          variant="ghost"
          href={address}
          target="_blank"
          rel="noopener noreferrer"
          xstyle={styles.open}
        />
      )}
    </article>
  );
}

const styles = stylex.create({
  quiet: {
    color: tm.textQuiet,
    fontWeight: fontWeightVars['--font-weight-normal'],
  },
  kind: {
    width: '18px',
    height: '18px',
    marginTop: '3px',
    color: colorVars['--color-text-secondary'],
  },
  // A hovered sheet takes the list's hover shade over its paper.
  sheet: {
    backgroundImage: {
      default: null,
      ':hover': {
        default: null,
        '@media (hover: hover)': `linear-gradient(${colorVars['--color-overlay-hover']}, ${colorVars['--color-overlay-hover']})`,
      },
    },
  },
  head: {
    display: 'flex',
    alignItems: 'baseline',
    gap: spacingVars['--spacing-2'],
    minWidth: 0,
  },
  // The title is the sheet's button, and reaches past it to the whole sheet, under its arrow.
  title: {
    flexGrow: 1,
    minWidth: 0,
    padding: 0,
    borderWidth: 0,
    backgroundColor: 'transparent',
    color: 'inherit',
    fontFamily: typographyVars['--font-family-body'],
    fontWeight: fontWeightVars['--font-weight-medium'],
    textAlign: 'start',
    cursor: 'pointer',
    outline: 'none',
    '::after': {
      content: '""',
      position: 'absolute',
      inset: 0,
      borderRadius: tm.sheetRadius,
    },
    ':focus-visible::after': {
      outline: `${focusVars['--focus-outline-width']} ${focusVars['--focus-outline-style']} ${focusVars['--focus-outline-color']}`,
      outlineOffset: focusVars['--focus-outline-offset'],
    },
  },
  unread: {
    fontWeight: fontWeightVars['--font-weight-semibold'],
  },
  dot: {
    display: 'inline-block',
    width: '7px',
    height: '7px',
    marginInlineEnd: '7px',
    marginBottom: '3px',
    verticalAlign: 'middle',
    borderRadius: '50%',
    backgroundColor: { default: colorVars['--color-accent'], [media.forcedColors]: 'CanvasText' },
  },
  number: {
    color: tm.textQuiet,
    fontSize: typeScaleVars['--text-body-size'],
    fontWeight: fontWeightVars['--font-weight-normal'],
    whiteSpace: 'nowrap',
  },
  commit: {
    fontFamily: typographyVars['--font-family-code'],
    fontSize: '0.86em',
  },
  time: {
    flexShrink: 0,
    color: tm.textQuiet,
    fontSize: typeScaleVars['--text-supporting-size'],
    whiteSpace: 'nowrap',
  },
  facts: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: spacingVars['--spacing-1'],
  },
  count: {
    marginInlineStart: spacingVars['--spacing-1'],
    color: tm.textQuiet,
    fontSize: typeScaleVars['--text-supporting-size'],
    whiteSpace: 'nowrap',
  },
  act: {
    color: colorVars['--color-text-secondary'],
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: { default: 'nowrap', [media.coarse]: 'normal' },
    display: { default: null, [media.coarse]: '-webkit-box' },
    WebkitLineClamp: { default: null, [media.coarse]: 2 },
    WebkitBoxOrient: { default: null, [media.coarse]: 'vertical' },
  },
  actor: {
    color: colorVars['--color-text-primary'],
    fontWeight: fontWeightVars['--font-weight-medium'],
  },
  // In the third column of the title's line, above the title's reach, so the arrow opens GitHub, not
  // the thread.
  open: {
    gridColumn: '3',
    gridRow: '1',
    position: 'relative',
    zIndex: 1,
    alignSelf: 'start',
    marginBlock: `calc(${spacingVars['--spacing-1']} * -1)`,
  },
  // The places the head and the sheets lie in, as tall as all of them, each drawn only in sight.
  places: (height: number) => ({ position: 'relative', height }),
  place: {
    position: 'absolute',
    top: 0,
    insetInline: 0,
    paddingBottom: spacingVars['--spacing-2'],
  },
  placed: (top: number) => ({ transform: `translateY(${top}px)` }),
});
