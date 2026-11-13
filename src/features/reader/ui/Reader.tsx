import { colorVars, fontWeightVars, spacingVars } from '@astryxdesign/core/theme/tokens.stylex';
import { Button } from '@astryxdesign/core/Button';
import { Icon } from '@astryxdesign/core/Icon';
import { VisuallyHidden } from '@astryxdesign/core/VisuallyHidden';
import * as stylex from '@stylexjs/stylex';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { ExternalLink } from 'lucide-react';
import { memo, useDeferredValue, useEffect, useEffectEvent, useRef, useState } from 'react';
import { stampStyles } from '../../../app/theme/stamps.ts';
import { useMediaQuery } from '../../../shared/useMediaQuery.ts';
import { media, tm } from '../../../app/theme/tokens.stylex.ts';
import type { Command } from '../../commands/index.ts';
import { numberOf } from '../../conversations/index.ts';
import { folderName } from '../../folders/index.ts';
import {
  threadAddressOf,
  threadOf,
  type Account,
  type ConversationId,
  type Folder,
  type GitHubThread,
  type Message,
  type MessageRef,
} from '../../mail/core/index.ts';
import { accountsQuery, bodyQuery, conversationQuery } from '../../mailroom/client/index.ts';
import {
  Airmail,
  isLeaving,
  isOnItsWay,
  leavingIn,
  useLeavingLine,
  type Leaving,
  type Shown,
} from '../../outbox/index.ts';
import { folderOf, receivedIn } from '../core/folder.ts';
import { REST_MS } from '../core/rest.ts';
import { bareSubject } from '../core/subject.ts';
import { threadStyles } from './layout.ts';
import { metaStyles } from './meta.ts';
import { MessageKeys } from './MessageFrame.tsx';
import { displayName, MessageSheet, when } from './MessageSheet.tsx';
import { refKey, refOf } from './refs.ts';
import { imagesAllowed, safeMail } from './safeMail.ts';

export type ReaderProps = {
  /** One conversation's messages, in any order. */
  conversation: Message[];
  account: Account;
  /** The member's folders, to name the one the conversation lies in. */
  folders?: readonly Folder[];
  /**
   * What can be done with one message, such as replying to it. The same function each render. The
   * keys of the registry's commands answer the newest message, so only its own name them.
   */
  actionsFor?: (message: Message) => readonly Command[];
  /** The conversations the member is likely to open next, prepared while the browser is idle. */
  upcoming?: ConversationId[];
  /**
   * Keys pressed inside a message's frame, which the page around the frame never hears, for the
   * workbench's shortcuts. The same function from one render to the next.
   */
  onMessageKey?: (event: KeyboardEvent) => void;
  /** Drafts left out, such as the one being written below the conversation. */
  hidden?: readonly MessageRef[];
  /** The sends this device follows, each a reply on its way at the end of its conversation. */
  leaving?: readonly Leaving[];
  /** Opens a draft to go on writing it. Without it, a draft reads like any message. */
  onOpenDraft?: (draft: Message) => void;
  /**
   * Whether the member has already moved on, as a held key passes the conversation its first press
   * opened. Its subject shows, and its messages wait until the member stays.
   */
  isPassing?: boolean;
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
  folders = NONE_LISTED,
  leaving = NONE_LEAVING,
  ...props
}: ReaderProps) {
  usePrepared(upcoming);
  const id = props.conversation[0]?.conversation ?? '';
  return (
    <MessageKeys value={onMessageKey ?? IGNORE_KEY}>
      <Conversation key={id} hidden={hidden} folders={folders} leaving={leaving} {...props} />
    </MessageKeys>
  );
}, isSameReading);

const IGNORE_KEY = () => {};
const NONE_HIDDEN: readonly MessageRef[] = [];
const NONE_LISTED: readonly Folder[] = [];
const NONE_LEAVING: readonly Leaving[] = [];

const keys = (refs: readonly MessageRef[] = NONE_HIDDEN) => refs.map(refKey).join('\u0001');

function isSameReading(before: ReaderProps, after: ReaderProps): boolean {
  const ids = (props: ReaderProps) => (props.upcoming ?? []).join('\u0000');
  return (
    before.conversation === after.conversation &&
    before.account === after.account &&
    before.folders === after.folders &&
    before.actionsFor === after.actionsFor &&
    before.onMessageKey === after.onMessageKey &&
    before.onOpenDraft === after.onOpenDraft &&
    before.isPassing === after.isPassing &&
    before.leaving === after.leaving &&
    keys(before.hidden) === keys(after.hidden) &&
    ids(before) === ids(after)
  );
}

/**
 * The conversation's messages, oldest first. A draft lies folded, and opening it goes on writing it
 * when the reader can, so the newest message that lies open is the newest one sent. Replies on their
 * way lie folded after them, as their copies will once the server has them.
 */
// A conversation renders again only when it changes, not when what the reader prepares does.
const Conversation = memo(function Conversation({
  conversation,
  account,
  folders,
  actionsFor,
  hidden,
  leaving,
  onOpenDraft,
  isPassing = false,
}: Omit<ReaderProps, 'hidden' | 'folders' | 'leaving'> & {
  hidden: readonly MessageRef[];
  folders: readonly Folder[];
  leaving: readonly Leaving[];
}) {
  const leftOut = new Set(hidden.map(refKey));
  const messages = conversation
    .filter((message) => !leftOut.has(refKey(message)))
    .toSorted((a, b) => a.date.localeCompare(b.date));
  const isDraft = (message: Message) => onOpenDraft !== undefined && message.flags.draft;
  const newest = messages.findLast((message) => !isDraft(message)) ?? messages.at(-1);
  // The newest opens, and the member opens earlier ones. A move gives a message a new ref, as an
  // undone archive's moves do, so an opened one is known by what it keeps: its Message-ID.
  const [opened, setOpened] = useState(() => new Set(newest ? [openedKey(newest)] : []));
  // The subject shows in the commit that opens the conversation, so a key that opens it paints at
  // once. Its open messages, with their frames, follow in a render of their own that yields to the
  // next keys, and not at all while a held key passes the conversation by.
  const isSheetsShown = useDeferredValue(!isPassing, false);
  const fetchAhead = useFetchAhead(account);
  if (!newest) return null;
  const folder = folderOf(messages, folders);
  const github = threadOf(receivedIn(messages, folders));
  const address = github && threadAddressOf(github);
  // A draft's line already says what it is, so the count is of the mail itself, and only a
  // conversation of drafts alone counts its drafts.
  const written = messages.filter((message) => !isDraft(message)).length;
  const size = written > 0 ? counted(written, 'message') : counted(messages.length, 'draft');
  const actionsOf = (message: Message) =>
    message === newest
      ? actionsFor?.(message)
      : actionsFor?.(message).map((action) => ({ ...action, shortcut: undefined }));

  return (
    <div {...stylex.props(threadStyles.thread)}>
      <h1 {...stylex.props(threadStyles.subject)}>{github?.title ?? subjectOf(messages)}</h1>
      <p {...stylex.props(threadStyles.meta, address !== undefined && metaStyles.wrapping)}>
        <span aria-hidden {...stylex.props(metaStyles.stamp, stampStyles[account.stamp])} />
        <span>
          {[account.name, ...(folder ? [folderName(folder)] : []), size].join(' · ')}
          {address && ' · '}
        </span>
        {github && address && <OnGitHub thread={github} address={address} />}
      </p>
      {messages.map((message) =>
        isDraft(message) ? (
          <button
            key={refKey(message)}
            type="button"
            onClick={() => onOpenDraft?.(message)}
            {...stylex.props(threadStyles.folded)}
          >
            <strong {...stylex.props(styles.foldedFrom, styles.draft)}>Draft</strong>
            <span {...stylex.props(styles.foldedPreview)}>{message.preview}</span>
            <span>Go on writing</span>
          </button>
        ) : opened.has(openedKey(message)) ? (
          isSheetsShown && (
            <MessageSheet
              key={refKey(message)}
              message={message}
              account={account}
              actions={actionsOf(message)}
            />
          )
        ) : (
          <button
            key={refKey(message)}
            type="button"
            onClick={() => setOpened(new Set([...opened, openedKey(message)]))}
            {...fetchAhead(message)}
            {...stylex.props(threadStyles.folded)}
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
      {leavingIn(leaving, newest.conversation, conversation).map((shown) => (
        <OnItsWay key={refKey(shown.leaving.draft)} shown={shown} />
      ))}
    </div>
  );
});

/**
 * A reply on its way, folded where its copy will lie, under airmail while it leaves. While the
 * member is here it says all there is to say of the send, in place of a toast: its countdown with
 * Undo, when it goes, that it's sending or went, or why it didn't with the way to the Outbox. One
 * this device has just sent comes into view, so the member sees it leave: on a phone, clear of the
 * island below it.
 */
function OnItsWay({ shown: { leaving, preview } }: { shown: Shown }) {
  const { standing, said, reason, action, told } = useLeavingLine(leaving);
  const row = useRef<HTMLDivElement>(null);
  const isPhone = useMediaQuery(media.phone);
  const isStill = useMediaQuery(media.reducedMotion);
  // Sent here, and still in its undo window as it first shows, rather than met later on.
  const [isJustSent] = useState(leaving.pressedIn !== undefined && standing.is === 'counting');
  const bringIntoView = useEffectEvent(() =>
    row.current?.scrollIntoView({
      block: isPhone ? 'center' : 'nearest',
      behavior: isStill ? 'instant' : 'smooth',
    }),
  );
  useEffect(() => {
    if (isJustSent) bringIntoView();
  }, [isJustSent]);
  return (
    <div ref={row} {...stylex.props(threadStyles.folded, styles.onItsWay)}>
      {isLeaving(standing) && <Airmail isRunning={isOnItsWay(standing)} xstyle={styles.airmail} />}
      <strong {...stylex.props(styles.foldedFrom)}>You</strong>
      <span {...stylex.props(styles.foldedPreview, styles.leavingPreview)}>{preview}</span>
      <span {...stylex.props(styles.said)}>{said}</span>
      {action && (
        <Button
          label={action.label}
          variant="ghost"
          size="sm"
          isLoading={action.isBusy}
          onClick={action.run}
          xstyle={styles.action}
        />
      )}
      {reason && <span {...stylex.props(styles.reason)}>{reason}</span>}
      <VisuallyHidden role="status">{told}</VisuallyHidden>
    </div>
  );
}

const counted = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`;

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

/**
 * An older message's body, asked for once the pointer rests on its folded line or the line takes
 * the focus, and sanitized while the browser is idle, so it is ready by the time the line opens. A
 * pointer that only passes over the line, as when the conversation scrolls under it, asks for
 * nothing.
 */
function useFetchAhead(account: Account) {
  const queryClient = useQueryClient();
  const resting = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(resting.current), []);
  return (message: Message) => {
    const ask = () => {
      clearTimeout(resting.current);
      void queryClient
        .fetchQuery(bodyQuery(refOf(message)))
        .then(async (body) => {
          await idle();
          safeMail(message, body, imagesAllowed(message, account.allowImagesFrom));
        })
        .catch(() => {});
    };
    return {
      onPointerEnter: () => {
        clearTimeout(resting.current);
        resting.current = setTimeout(ask, REST_MS);
      },
      onPointerLeave: () => clearTimeout(resting.current),
      onFocus: ask,
    };
  };
}

/** Resolves when the browser has nothing more pressing to do. Safari has no idle callback. */
function idle(): Promise<void> {
  return new Promise((resolve) => {
    if ('requestIdleCallback' in window) requestIdleCallback(() => resolve());
    else setTimeout(resolve, 50);
  });
}

/** Where a GitHub thread lives on github.com, named by its number, or by its kind when it has none. */
function OnGitHub({ thread, address }: { thread: GitHubThread; address: string }) {
  return (
    <a href={address} target="_blank" rel="noopener noreferrer" {...stylex.props(metaStyles.link)}>
      {numberOf(thread)?.text ?? (thread.kind === 'run' ? 'Run' : 'Thread')} on GitHub
      <Icon icon={ExternalLink} size="xsm" xstyle={metaStyles.linkIcon} />
    </a>
  );
}

/** The conversation's subject, as its first message gave it. */
const subjectOf = (messages: Message[]) => bareSubject(messages[0]?.subject ?? '');

const styles = stylex.create({
  // Nothing to open yet, so it neither lifts nor points.
  onItsWay: {
    position: 'relative',
    flexWrap: 'wrap',
    overflow: 'hidden',
    backgroundColor: 'transparent',
    color: tm.textQuiet,
    cursor: 'default',
  },
  airmail: {
    position: 'absolute',
    insetInline: 0,
    top: 0,
  },
  // The line breaks only before the reason, so the preview gives way to what follows it.
  leavingPreview: {
    flexBasis: 0,
  },
  said: {
    flexShrink: 0,
    fontVariantNumeric: 'tabular-nums',
  },
  // Undo, or the way to the Outbox, ends the line, as a button does a toast.
  action: {
    flexShrink: 0,
    marginInlineEnd: `calc(-1 * ${spacingVars['--spacing-2']})`,
    fontWeight: fontWeightVars['--font-weight-semibold'],
  },
  // Why it hasn't gone takes a line of its own beneath, wrapping as long as it runs.
  reason: {
    flexBasis: '100%',
    paddingBottom: spacingVars['--spacing-2'],
    color: colorVars['--color-text-secondary'],
    whiteSpace: 'normal',
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
