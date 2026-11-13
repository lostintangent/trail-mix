import { Skeleton } from '@astryxdesign/core/Skeleton';
import { typeScaleVars } from '@astryxdesign/core/theme/tokens.stylex';
import * as stylex from '@stylexjs/stylex';
import { Pending, TextSkeleton } from '../../../app/theme/Pending.tsx';
import { tm } from '../../../app/theme/tokens.stylex.ts';
import { bareSubject } from '../core/subject.ts';
import { issueStyles, sheetStyles, threadStyles } from './layout.ts';

/**
 * A conversation on its way, in the shapes it arrives in: its subject and the line under it, an
 * older message folded to its line, and the newest open on its sheet. The subject is the list's,
 * when the list has it, so it shows at once, and only what is still to come waits. Nothing lies
 * below a conversation to hold still, so its skeletons are drawn only once it is late.
 */
export function ReaderSkeleton({ subject }: { subject?: string }) {
  const coming = (
    <>
      <div {...stylex.props(threadStyles.meta)}>
        <span>
          <TextSkeleton width="14em" index={1} />
        </span>
      </div>
      <div {...stylex.props(threadStyles.folded, styles.still)}>
        <span {...stylex.props(styles.grow)}>
          <TextSkeleton width="45%" index={2} />
        </span>
      </div>
      <div {...stylex.props(sheetStyles.sheet)}>
        <div {...stylex.props(sheetStyles.from)}>
          <Skeleton width="32px" height="32px" radius="rounded" index={3} />
          <div {...stylex.props(sheetStyles.who)}>
            <span>
              <TextSkeleton width="30%" index={3} />
            </span>
            <span {...stylex.props(sheetStyles.quiet)}>
              <TextSkeleton width="45%" index={4} />
            </span>
          </div>
        </div>
        <BodyLines first={5} />
      </div>
    </>
  );
  return subject === undefined ? (
    <Pending label="Opening the conversation" xstyle={threadStyles.thread} holdsPlace={false}>
      <div {...stylex.props(threadStyles.subject)}>
        <TextSkeleton width="55%" />
      </div>
      {coming}
    </Pending>
  ) : (
    <div {...stylex.props(threadStyles.thread)}>
      <h1 {...stylex.props(threadStyles.subject)}>{bareSubject(subject)}</h1>
      <Pending label="Opening the conversation" xstyle={threadStyles.stack} holdsPlace={false}>
        {coming}
      </Pending>
    </div>
  );
}

/**
 * A bundle on its way: its repository, which the list already has, the line under it, and a few of
 * its threads' sheets.
 */
export function BundleSkeleton({ repository }: { repository?: string }) {
  return (
    <div {...stylex.props(threadStyles.thread)}>
      <h1 {...stylex.props(threadStyles.subject)}>{repository ?? <TextSkeleton width="40%" />}</h1>
      <Pending label="Opening the repository" xstyle={threadStyles.stack} holdsPlace={false}>
        <div {...stylex.props(threadStyles.meta)}>
          <span>
            <TextSkeleton width="16em" index={1} />
          </span>
        </div>
        {[0, 1, 2].map((sheet) => (
          <ThreadSkeleton key={sheet} place={sheet} />
        ))}
      </Pending>
    </div>
  );
}

/**
 * A thread of a bundle on its way, as a sheet in its shape, its title as long as the place it
 * stands in gives it.
 */
export function ThreadSkeleton({ place }: { place: number }) {
  return (
    <div {...stylex.props(issueStyles.sheet)}>
      <Skeleton width="18px" height="18px" radius="rounded" index={place + 2} />
      <div {...stylex.props(issueStyles.head, issueStyles.title)}>
        <TextSkeleton
          width={ISSUE_WIDTHS[place % ISSUE_WIDTHS.length] ?? '62%'}
          index={place + 2}
        />
      </div>
      <div {...stylex.props(issueStyles.under, issueStyles.facts, styles.facts)}>
        <Skeleton width="30%" height="100%" radius="rounded" index={place + 3} />
      </div>
      <div {...stylex.props(issueStyles.under, issueStyles.act)}>
        <TextSkeleton width="80%" index={place + 3} />
      </div>
    </div>
  );
}

/** A thread title's width on each of a bundle's skeleton sheets, in turn. */
const ISSUE_WIDTHS = ['62%', '48%', '70%'];

/** A message's body on its way, as lines of text on its sheet. */
export function BodySkeleton() {
  return (
    <Pending label="Opening the message">
      <BodyLines first={0} />
    </Pending>
  );
}

function BodyLines({ first }: { first: number }) {
  return (
    <div {...stylex.props(styles.body)}>
      {BODY_WIDTHS.map((width, line) => (
        <div key={line}>
          <TextSkeleton width={width} index={first + line} />
        </div>
      ))}
    </div>
  );
}

/** A few lines of a message, of differing lengths, the last one short as a paragraph's is. */
const BODY_WIDTHS = ['94%', '88%', '97%', '91%', '62%'];

const styles = stylex.create({
  // A folded line on its way can't be opened yet, so it neither lifts nor points.
  still: {
    backgroundColor: 'transparent',
    cursor: 'default',
  },
  grow: {
    flexGrow: 1,
  },
  // What GitHub said of a thread, a line of chips as tall as one.
  facts: {
    display: 'flex',
    height: tm.chipHeight,
  },
  // A body is set in the reader's type, as a message's frame sets it.
  body: {
    fontSize: typeScaleVars['--text-body-size'],
    lineHeight: typeScaleVars['--text-body-leading'],
  },
});
