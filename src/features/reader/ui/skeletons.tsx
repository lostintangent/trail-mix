import { Skeleton } from '@astryxdesign/core/Skeleton';
import { typeScaleVars } from '@astryxdesign/core/theme/tokens.stylex';
import * as stylex from '@stylexjs/stylex';
import { Pending, TextSkeleton } from '../../../app/theme/Pending.tsx';
import { tm } from '../../../app/theme/tokens.stylex.ts';
import { bareSubject } from '../core/subject.ts';
import { sheetStyles, threadStyles } from './layout.ts';

/**
 * A conversation on its way, in the shapes it arrives in: its subject and the line under it, an
 * older message folded to its line, and the newest open on its sheet. The subject is the list's,
 * when the list has it, so it shows at once, and only what is still to come waits.
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
          <Skeleton width={tm.target} height={tm.target} radius="rounded" index={3} />
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
    <Pending label="Opening the conversation" xstyle={threadStyles.thread}>
      <div {...stylex.props(threadStyles.subject)}>
        <TextSkeleton width="55%" />
      </div>
      {coming}
    </Pending>
  ) : (
    <div {...stylex.props(threadStyles.thread)}>
      <h1 {...stylex.props(threadStyles.subject)}>{bareSubject(subject)}</h1>
      <Pending label="Opening the conversation" xstyle={threadStyles.stack}>
        {coming}
      </Pending>
    </div>
  );
}

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
  // A body is set in the reader's type, as a message's frame sets it.
  body: {
    fontSize: typeScaleVars['--text-body-size'],
    lineHeight: typeScaleVars['--text-body-leading'],
  },
});
