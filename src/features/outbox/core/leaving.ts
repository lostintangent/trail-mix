import {
  sameRef,
  type ConversationId,
  type Message,
  type MessageRef,
  type Outgoing,
} from '../../mail/core/index.ts';
import {
  closesAfterPress,
  follow,
  followed,
  isOnItsWay,
  standingOfFollowed,
  standingOfWait,
  type Followed,
  type Standing,
} from './standing.ts';

/**
 * The sends a device follows to the ends of their conversations, where each lies as a reply on its
 * way until the server's copy takes its place. A send this device asked for is followed from the
 * press, before the Mailroom has it, and one asked for elsewhere from the first snapshot of the
 * Outbox that holds it. Each is followed through the Outbox's snapshots, so one gone from the
 * Outbox keeps its place if it went, and leaves at once if it was undone or given up. One that
 * failed stays, saying why. Its draft stays out of the conversation all the while.
 */
export type Leaving = {
  draft: MessageRef;
  /** The conversation a reply was pressed in. One asked for elsewhere is where the Outbox says. */
  pressedIn?: ConversationId;
  /** What the press sent, as a conversation's line reads it, until the index has the draft. */
  preview?: string;
  /** When its undo window closes on this device's clock. */
  closes: number;
  /** What this device has seen of it in the Outbox, once the Mailroom has it. */
  seen?: Followed;
};

/**
 * How long a send gone from the Outbox keeps its place without its copy in Sent. The Mailroom
 * reads Sent as soon as the send leaves, so this only bounds a copy that went elsewhere.
 */
export const GONE_MS = 30_000;

/**
 * A press of Send, for `at` if later than the undo window: the reply is on its way at once. A press
 * of the same draft replaces the one before.
 */
export function press(
  all: readonly Leaving[],
  {
    draft,
    pressedIn,
    written,
    pressedAt,
    at,
  }: {
    draft: MessageRef;
    pressedIn: ConversationId | undefined;
    /** The Markdown the member wrote. */
    written: string;
    pressedAt: number;
    at: string | undefined;
  },
): readonly Leaving[] {
  const window = closesAfterPress(pressedAt);
  const closes = at === undefined ? window : Math.max(window, Date.parse(at));
  return [
    ...forget(all, draft),
    { draft, ...(pressedIn && { pressedIn }), preview: previewOf(written), closes },
  ];
}

/** A send this device no longer follows: the Mailroom refused it, or this device took it back. */
export const forget = (all: readonly Leaving[], draft: MessageRef): readonly Leaving[] =>
  all.filter((leaving) => !sameRef(leaving.draft, draft));

/**
 * What a snapshot of the Outbox, taken by `at`, shows. Each send it holds is followed, and each
 * followed one it lacks is seen gone. `closesFor` says when a send's window closes on this device.
 * A press stays as it was until the Outbox holds its send, since a snapshot can be older than it.
 */
export function observe(
  all: readonly Leaving[],
  outbox: readonly Outgoing[],
  at: number,
  closesFor: (outgoing: Outgoing) => number,
): readonly Leaving[] {
  const entryOf = (draft: MessageRef) => outbox.find((held) => sameRef(held.draft, draft));
  const seen = all.map((leaving): Leaving => {
    const entry = entryOf(leaving.draft);
    const closes = entry ? closesFor(entry) : leaving.closes;
    if (leaving.seen) return { ...leaving, closes, seen: follow(leaving.seen, entry, at) };
    return entry ? { ...leaving, closes, seen: followed(entry) } : leaving;
  });
  const added = outbox
    .filter((held) => !all.some((leaving) => sameRef(leaving.draft, held.draft)))
    .map((held): Leaving => ({ draft: held.draft, closes: closesFor(held), seen: followed(held) }));
  return expire([...seen, ...added], at);
}

/** The sends still followed at `now`: none undone or given up, nor gone without a copy too long. */
export function expire(all: readonly Leaving[], now: number): readonly Leaving[] {
  const isOver = ({ seen, closes }: Leaving) =>
    seen?.goneAt !== undefined &&
    (now - seen.goneAt > GONE_MS || standingOfFollowed(seen, closes, now, false).is === 'undone');
  return all.some(isOver) ? all.filter((leaving) => !isOver(leaving)) : all;
}

/** When the next of the sends gone from the Outbox stops waiting for its copy, if any is. */
export function nextExpiry(all: readonly Leaving[]): number | undefined {
  const ends = all.flatMap(({ seen }) =>
    seen?.goneAt === undefined ? [] : [seen.goneAt + GONE_MS],
  );
  return ends.length > 0 ? Math.min(...ends) : undefined;
}

/**
 * The drafts of the sends followed, which their conversations leave out, since each lies at the end
 * of its conversation as its send instead: on its way, or saying why it didn't go.
 */
export const draftsLeaving = (all: readonly Leaving[]): MessageRef[] =>
  all.map(({ draft }) => draft);

/**
 * Whether a send is away from its draft, which Drafts leaves out: on its way, or gone, but not
 * failed and back.
 */
export const isAway = ({ seen }: Leaving) =>
  seen?.goneAt !== undefined || seen?.last.state !== 'failed';

/** The conversation a send is in: where its reply was pressed, or where the Outbox places it. */
export const conversationOf = (leaving: Leaving): ConversationId | undefined =>
  leaving.pressedIn ?? leaving.seen?.last.conversation;

/**
 * The replies on their way at the end of a conversation, and those that didn't go, given its
 * messages, soonest to go first. One gives way to its copy once the conversation holds a message by
 * its Message-ID that is not a draft, in the same snapshot that shows the copy.
 */
export function leavingIn(
  all: readonly Leaving[],
  conversation: ConversationId,
  messages: readonly Message[],
): Shown[] {
  return all
    .flatMap((leaving): Shown[] => {
      const draft = messages.find((message) => sameRef(message, leaving.draft));
      if (conversationOf(leaving) !== conversation) return [];
      const messageId = leaving.seen?.last.messageId ?? draft?.messageId;
      const isCopied = messages.some(
        (message) => !message.flags.draft && !!messageId && message.messageId === messageId,
      );
      return isCopied ? [] : [{ leaving, preview: leaving.preview ?? draft?.preview ?? '' }];
    })
    .toSorted((a, b) => a.leaving.closes - b.leaving.closes);
}

/** A reply on its way as its conversation shows it: what it says, the way its copy will. */
export type Shown = { leaving: Leaving; preview: string };

/** Whether a reply gone from the Outbox waits for its copy, which its conversation should fetch. */
export const isAwaitingCopy = ({ leaving }: Shown) => leaving.seen?.goneAt !== undefined;

/**
 * What a send's toast does as the member moves. While they're on the send's conversation, its line
 * there says everything, so the toast is put away. Elsewhere it shows when this device first sees
 * the send, as a new message's does, and when they leave the conversation while the send is on its
 * way. Otherwise it stays as it is: shown, it follows the send to its end.
 */
export function toastFor(
  leaving: Leaving,
  shown: ConversationId | undefined,
  isFirstSight: boolean,
  now: number,
): 'show' | 'put away' | 'stay' {
  if (shown !== undefined && conversationOf(leaving) === shown) return 'put away';
  return isFirstSight || isOnItsWay(standingOfLeaving(leaving, now)) ? 'show' : 'stay';
}

/** Where a send followed to its conversation stands at `now`. */
export function standingOfLeaving({ seen, closes }: Leaving, now: number): Standing {
  if (seen) return standingOfFollowed(seen, closes, now, false);
  return standingOfWait(new Date(closes).toISOString(), closes, now);
}

/**
 * What a conversation's line shows of the Markdown a member sent, as the index reads the message's
 * plain-text part, which is that Markdown: its lines but quoted ones, run together.
 */
function previewOf(written: string): string {
  return written
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith('>'))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, PREVIEW_LENGTH);
}

const PREVIEW_LENGTH = 200;
