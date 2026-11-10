import {
  borderVars,
  colorVars,
  focusVars,
  fontWeightVars,
  radiusVars,
  spacingVars,
  typeScaleVars,
  typographyVars,
} from '@astryxdesign/core/theme/tokens.stylex';
import * as stylex from '@stylexjs/stylex';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { memo, useEffect, useState } from 'react';
import { stampStyles } from '../../../app/theme/stamps.ts';
import { media, tm } from '../../../app/theme/tokens.stylex.ts';
import type { Account, ConversationId, Message, MessageRef } from '../../mail/core/index.ts';
import { accountsQuery, bodyQuery, conversationQuery } from '../../mailroom/client/index.ts';
import { MessageKeys } from './MessageFrame.tsx';
import { displayName, MessageSheet, when } from './MessageSheet.tsx';
import { imagesAllowed, refKey, refOf, safeMail } from './safeMail.ts';

export type ReaderProps = {
  /** One conversation's messages, in any order. */
  conversation: Message[];
  account: Account;
  /** The conversations the member is likely to open next, prepared while the browser is idle. */
  upcoming?: ConversationId[];
  /**
   * Keys pressed inside a message's frame, which the page around the frame never hears, for the
   * workbench's shortcuts. The same function from one render to the next.
   */
  onMessageKey?: (event: KeyboardEvent) => void;
  /** Drafts left out, such as the one being written below the conversation. */
  hidden?: readonly MessageRef[];
  /** Opens a draft to go on writing it. Without it, a draft reads like any message. */
  onOpenDraft?: (draft: Message) => void;
};

/**
 * A conversation, read as a stack of sheets: its subject set like a letter's, then each message
 * oldest first. Older messages are folded to one line and the newest lies open. Opening one keeps
 * it open while the conversation is on screen.
 *
 * It renders again only when what it shows or prepares changes, so moving through the list while
 * the reader waits costs it nothing.
 */
export const Reader = memo(function Reader({
  upcoming = [],
  onMessageKey,
  hidden = NONE_HIDDEN,
  ...props
}: ReaderProps) {
  usePrepared(upcoming);
  const id = props.conversation[0]?.conversation ?? '';
  return (
    <MessageKeys value={onMessageKey ?? IGNORE_KEY}>
      <Conversation key={id} hidden={hidden} {...props} />
    </MessageKeys>
  );
}, isSameReading);

const IGNORE_KEY = () => {};
const NONE_HIDDEN: readonly MessageRef[] = [];

const keys = (refs: readonly MessageRef[] = NONE_HIDDEN) => refs.map(refKey).join('\u0001');

function isSameReading(before: ReaderProps, after: ReaderProps): boolean {
  const ids = (props: ReaderProps) => (props.upcoming ?? []).join('\u0000');
  return (
    before.conversation === after.conversation &&
    before.account === after.account &&
    before.onMessageKey === after.onMessageKey &&
    before.onOpenDraft === after.onOpenDraft &&
    keys(before.hidden) === keys(after.hidden) &&
    ids(before) === ids(after)
  );
}

/**
 * The conversation's messages, oldest first. A draft lies folded, and opening it goes on writing it
 * when the reader can, so the newest message that lies open is the newest one sent.
 */
function Conversation({
  conversation,
  account,
  hidden,
  onOpenDraft,
}: Omit<ReaderProps, 'hidden'> & { hidden: readonly MessageRef[] }) {
  const leftOut = new Set(hidden.map(refKey));
  const messages = conversation
    .filter((message) => !leftOut.has(refKey(message)))
    .toSorted((a, b) => a.date.localeCompare(b.date));
  const isDraft = (message: Message) => onOpenDraft !== undefined && message.flags.draft;
  const newest = messages.findLast((message) => !isDraft(message)) ?? messages.at(-1);
  // The newest opens, and the member opens earlier ones. A move gives a message a new ref, as an
  // undone archive's moves do, so an opened one is known by what it keeps: its Message-ID.
  const [opened, setOpened] = useState(() => new Set(newest ? [openedKey(newest)] : []));
  if (!newest) return null;

  return (
    <div {...stylex.props(styles.thread)}>
      <h1 {...stylex.props(styles.subject)}>{subjectOf(messages)}</h1>
      <p {...stylex.props(styles.meta)}>
        <span aria-hidden {...stylex.props(styles.stamp, stampStyles[account.stamp])} />
        {account.name} · {messages.length === 1 ? '1 message' : `${messages.length} messages`}
      </p>
      {messages.map((message) =>
        isDraft(message) ? (
          <button
            key={refKey(message)}
            type="button"
            onClick={() => onOpenDraft?.(message)}
            {...stylex.props(styles.folded)}
          >
            <strong {...stylex.props(styles.foldedFrom, styles.draft)}>Draft</strong>
            <span {...stylex.props(styles.foldedPreview)}>{message.preview}</span>
            <span>Go on writing</span>
          </button>
        ) : opened.has(openedKey(message)) ? (
          <MessageSheet key={refKey(message)} message={message} account={account} />
        ) : (
          <button
            key={refKey(message)}
            type="button"
            onClick={() => setOpened(new Set([...opened, openedKey(message)]))}
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

/** How the reader remembers an opened message: by its Message-ID, or its ref if it has none. */
const openedKey = (message: Message) => message.messageId || refKey(message);

/**
 * Fetches the newest body of each conversation the member may open next, and sanitizes it, one at
 * a time while the browser is idle, so moving to one shows prepared mail.
 */
function usePrepared(upcoming: ConversationId[]) {
  const queryClient = useQueryClient();
  const key = upcoming.join('\u0000');
  useEffect(() => {
    let cancelled = false;
    const prepare = async () => {
      for (const id of key ? key.split('\u0000') : []) {
        await idle();
        if (cancelled) return;
        await prepareConversation(queryClient, id, () => cancelled).catch(() => {});
      }
    };
    void prepare();
    return () => {
      cancelled = true;
    };
  }, [queryClient, key]);
}

async function prepareConversation(
  queryClient: QueryClient,
  id: ConversationId,
  isCancelled: () => boolean,
) {
  const messages = await queryClient.ensureQueryData(conversationQuery(id));
  const newest = messages.toSorted((a, b) => a.date.localeCompare(b.date)).at(-1);
  if (!newest) return;
  const body = await queryClient.ensureQueryData(bodyQuery(refOf(newest)));
  const accounts = queryClient.getQueryData(accountsQuery.queryKey) ?? [];
  const account = accounts.find(({ id: accountId }) => accountId === newest.account);
  await idle();
  // Sanitizing a large body is one long task, so it never starts once the member has moved on.
  if (isCancelled()) return;
  safeMail(newest, body, imagesAllowed(newest, account?.allowImagesFrom ?? []));
}

/** Resolves when the browser has nothing more pressing to do. Safari has no idle callback. */
function idle(): Promise<void> {
  return new Promise((resolve) => {
    if ('requestIdleCallback' in window) requestIdleCallback(() => resolve());
    else setTimeout(resolve, 50);
  });
}

/** The conversation's subject, as its first message gave it. */
function subjectOf(messages: Message[]): string {
  const subject = messages[0]?.subject.replace(/^(\s*(re|fwd?|aw|wg|sv|vs)\s*:\s*)+/i, '').trim();
  return subject || '(no subject)';
}

const FOCUS_RING = `${focusVars['--focus-outline-width']} ${focusVars['--focus-outline-style']} ${focusVars['--focus-outline-color']}`;

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
    // Quiet ink falls under 4.5:1 on the hover's shade, so a hovered line takes darker ink.
    color: { default: tm.textQuiet, ':hover': colorVars['--color-text-secondary'] },
    fontFamily: typographyVars['--font-family-body'],
    fontSize: typeScaleVars['--text-supporting-size'],
    textAlign: 'start',
    whiteSpace: 'nowrap',
    cursor: 'pointer',
    outline: {
      default: null,
      [media.forcedColors]: `${borderVars['--border-width']} solid CanvasText`,
      ':focus-visible': FOCUS_RING,
    },
    outlineOffset: focusVars['--focus-outline-offset'],
  },
  foldedFrom: {
    color: colorVars['--color-text-secondary'],
    fontWeight: fontWeightVars['--font-weight-semibold'],
  },
  draft: {
    color: colorVars['--color-accent'],
  },
  foldedPreview: {
    flexGrow: 1,
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
});
