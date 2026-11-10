import {
  borderVars,
  colorVars,
  fontWeightVars,
  radiusVars,
  spacingVars,
  typeScaleVars,
  typographyVars,
} from '@astryxdesign/core/theme/tokens.stylex';
import * as stylex from '@stylexjs/stylex';
import { useState } from 'react';
import { stampStyles } from '../../../app/theme/stamps.ts';
import { media, tm } from '../../../app/theme/tokens.stylex.ts';
import type { Account, Body, Message } from '../../mail/core/index.ts';
import { displayName, MessageSheet, refKey, when, type MessageUrls } from './MessageSheet.tsx';

export type ReaderProps = {
  /** One conversation's messages, in any order. */
  conversation: Message[];
  account: Account;
  /** A message's body, or undefined until it is fetched. */
  bodyOf: (message: Message) => Body | undefined;
  urls: MessageUrls;
  /** From now on, this sender's remote images load. */
  onAllowImages: (sender: string) => void;
};

/**
 * A conversation, read as a stack of sheets: its subject set like a letter's, then each message
 * oldest first. Older messages are folded to one line and the newest lies open. Opening one keeps
 * it open while the conversation is on screen.
 */
export function Reader(props: ReaderProps) {
  const id = props.conversation[0]?.conversation ?? '';
  return <Conversation key={id} {...props} />;
}

function Conversation({ conversation, account, bodyOf, urls, onAllowImages }: ReaderProps) {
  const messages = conversation.toSorted((a, b) => a.date.localeCompare(b.date));
  const newest = messages.at(-1);
  const [opened, setOpened] = useState(() => new Set(newest ? [refKey(newest)] : []));
  if (!newest) return null;

  return (
    <div {...stylex.props(styles.thread)}>
      <h1 {...stylex.props(styles.subject)}>{subjectOf(messages)}</h1>
      <p {...stylex.props(styles.meta)}>
        <span aria-hidden {...stylex.props(styles.stamp, stampStyles[account.stamp])} />
        {account.name} · {messages.length === 1 ? '1 message' : `${messages.length} messages`}
      </p>
      {messages.map((message) =>
        opened.has(refKey(message)) ? (
          <MessageSheet
            key={refKey(message)}
            message={message}
            body={bodyOf(message)}
            account={account}
            urls={urls}
            onAllowImages={onAllowImages}
          />
        ) : (
          <button
            key={refKey(message)}
            type="button"
            onClick={() => setOpened(new Set([...opened, refKey(message)]))}
            {...stylex.props(styles.folded)}
          >
            <strong {...stylex.props(styles.foldedFrom)}>
              {message.from.email.toLowerCase() === account.address.toLowerCase()
                ? 'You'
                : displayName(message.from)}
            </strong>
            <span {...stylex.props(styles.foldedPreview)}>{message.preview}</span>
            <time dateTime={message.date}>{when(message.date)}</time>
          </button>
        ),
      )}
    </div>
  );
}

/** The conversation's subject, as its first message gave it. */
function subjectOf(messages: Message[]): string {
  const subject = messages[0]?.subject.replace(/^(\s*(re|fwd?|aw|wg|sv|vs)\s*:\s*)+/i, '').trim();
  return subject || '(no subject)';
}

const styles = stylex.create({
  thread: {
    display: 'flex',
    flexDirection: 'column',
    gap: spacingVars['--spacing-2'],
    paddingInline: {
      default: spacingVars['--spacing-6'],
      [media.phone]: spacingVars['--spacing-3'],
    },
    paddingBottom: spacingVars['--spacing-6'],
  },
  subject: {
    margin: 0,
    fontFamily: tm.serif,
    fontSize: typeScaleVars['--text-heading-1-size'],
    fontWeight: typeScaleVars['--text-heading-1-weight'],
    lineHeight: typeScaleVars['--text-heading-1-leading'],
    overflowWrap: 'anywhere',
  },
  meta: {
    display: 'flex',
    alignItems: 'center',
    gap: spacingVars['--spacing-1-5'],
    margin: 0,
    marginBottom: spacingVars['--spacing-1'],
    color: tm.textQuiet,
    fontSize: typeScaleVars['--text-supporting-size'],
  },
  stamp: {
    width: spacingVars['--spacing-2'],
    height: spacingVars['--spacing-2'],
    flexShrink: 0,
    borderRadius: radiusVars['--radius-inner'],
    outline: {
      default: null,
      [media.forcedColors]: `${borderVars['--border-width']} solid CanvasText`,
    },
  },
  folded: {
    display: 'flex',
    alignItems: 'center',
    gap: spacingVars['--spacing-2'],
    minHeight: tm.target,
    paddingInline: spacingVars['--spacing-3'],
    borderWidth: 0,
    borderRadius: tm.sheetRadius,
    boxShadow: `0 0 0 ${borderVars['--border-width']} ${colorVars['--color-border']}`,
    backgroundColor: { default: 'transparent', ':hover': colorVars['--color-overlay-hover'] },
    color: tm.textQuiet,
    fontFamily: typographyVars['--font-family-body'],
    fontSize: typeScaleVars['--text-supporting-size'],
    textAlign: 'start',
    whiteSpace: 'nowrap',
    cursor: 'pointer',
    outline: {
      default: null,
      [media.forcedColors]: `${borderVars['--border-width']} solid CanvasText`,
    },
  },
  foldedFrom: {
    color: colorVars['--color-text-secondary'],
    fontWeight: fontWeightVars['--font-weight-semibold'],
  },
  foldedPreview: {
    flexGrow: 1,
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
});
