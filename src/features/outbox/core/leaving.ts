import {
  sameRef,
  type Address,
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
 * press, before its last save has made the draft it sends, and one asked for elsewhere from the
 * first snapshot of the Outbox that holds it. Each is followed through the Outbox's snapshots, so
 * one gone from the Outbox keeps its place if it went, and leaves at once if it was undone or given
 * up. One that failed stays, saying why. Its drafts stay out of the conversation all the while.
 */
export type Leaving = {
  /** The press, or for a send asked for elsewhere, its id in the Outbox. */
  id: string;
  /**
   * Every draft the message has been saved as since the press, the last the one it sends, which
   * replaced the others. None, until a message never saved has been.
   */
  drafts: readonly MessageRef[];
  /** Whom the press sent it to, until the Outbox says. */
  to?: readonly Address[];
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
 * A press of Send, for `at` if later than the undo window: the reply is on its way at once, from
 * the draft the message was last saved as, if it has been. A press of the same draft replaces the
 * one before.
 */
export function press(
  all: readonly Leaving[],
  {
    id,
    draft,
    pressedIn,
    written,
    to,
    pressedAt,
    at,
  }: {
    id: string;
    draft: MessageRef | undefined;
    pressedIn: ConversationId | undefined;
    /** The Markdown the member wrote. */
    written: string;
    to: readonly Address[];
    pressedAt: number;
    at: string | undefined;
  },
): readonly Leaving[] {
  const others = all.filter(
    (leaving) => leaving.id !== id && !(draft && leaving.drafts.some((was) => sameRef(was, draft))),
  );
  return [
    ...others,
    {
      id,
      drafts: draft ? [draft] : [],
      to,
      ...(pressedIn && { pressedIn }),
      preview: previewOf(written),
      closes: closesAfterPress(pressedAt, at),
    },
  ];
}

/** A press's message, saved again as `draft` on its way to the Mailroom, which replaced the last. */
export const named = (all: readonly Leaving[], id: string, draft: MessageRef): readonly Leaving[] =>
  all.map((leaving) => (leaving.id === id ? savedAs(leaving, draft) : leaving));

function savedAs(leaving: Leaving, draft: MessageRef): Leaving {
  const last = draftOf(leaving);
  return last && sameRef(last, draft)
    ? leaving
    : { ...leaving, drafts: [...leaving.drafts, draft] };
}

/** A send this device no longer follows: the Mailroom refused it, or this device took it back. */
export const forget = (all: readonly Leaving[], id: string): readonly Leaving[] =>
  all.filter((leaving) => leaving.id !== id);

/** The draft a send sends: the one its message was last saved as. */
export const draftOf = (leaving: Leaving): MessageRef | undefined => leaving.drafts.at(-1);

/**
 * What a snapshot of the Outbox, taken by `at`, shows. Each send it holds is followed, and each
 * followed one it lacks is seen gone. `closesFor` says when a send's window closes on this device.
 * A press stays as it was until the Outbox holds its send, since a snapshot can be older than it. A
 * send is known by the press that names it, which can show it before the press hears what draft its
 * last save made, or else by the draft it sends, so one of a draft its message replaced is another's.
 */
export function observe(
  all: readonly Leaving[],
  outbox: readonly Outgoing[],
  at: number,
  closesFor: (outgoing: Outgoing) => number,
): readonly Leaving[] {
  const entryOf = (leaving: Leaving) => {
    const draft = draftOf(leaving);
    return (
      outbox.find((held) => held.id === leaving.id) ??
      (draft && outbox.find((held) => sameRef(held.draft, draft)))
    );
  };
  const seen = all.map((leaving): Leaving => {
    const entry = entryOf(leaving);
    const closes = entry ? closesFor(entry) : leaving.closes;
    const known = entry ? savedAs(leaving, entry.draft) : leaving;
    if (leaving.seen) return { ...known, closes, seen: follow(leaving.seen, entry, at) };
    return entry ? { ...known, closes, seen: followed(entry) } : leaving;
  });
  const added = outbox
    .filter((held) => !all.some((leaving) => entryOf(leaving) === held))
    .map((held): Leaving => ({
      id: held.id,
      drafts: [held.draft],
      closes: closesFor(held),
      seen: followed(held),
    }));
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
  all.flatMap(({ drafts }) => drafts);

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
      const draft = messages.find((message) =>
        leaving.drafts.some((each) => sameRef(message, each)),
      );
      if (conversationOf(leaving) !== conversation) return [];
      const messageId = leaving.seen?.last.messageId ?? draft?.messageId;
      return holdsCopy(messages, messageId)
        ? []
        : [{ leaving, preview: leaving.preview ?? draft?.preview ?? '' }];
    })
    .toSorted((a, b) => a.leaving.closes - b.leaving.closes);
}

/** Whether a conversation's messages hold a send's copy: one by its Message-ID that isn't a draft. */
export const holdsCopy = (messages: readonly Message[], messageId: string | undefined) =>
  messageId !== undefined &&
  messages.some((message) => !message.flags.draft && message.messageId === messageId);

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
