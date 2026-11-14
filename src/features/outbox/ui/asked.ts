import { useSyncExternalStore } from 'react';
import type { Address, MessageRef, Outgoing } from '../../mail/core/index.ts';
import type { LastSave } from '../../mailroom/client/index.ts';
import { closesAfterPress, closesAt, type Followed } from '../core/standing.ts';

/**
 * A press of Send. The composer has closed, and the message goes to the Mailroom in one request,
 * carrying its last save if it has changes unsaved, so the undo window counts from the press. A
 * request that gets no answer asks again under the press, so the message comes back only once the
 * Mailroom has refused it or Undo has taken it back.
 */
export type Press = {
  id: string;
  /**
   * What the message sends, once any save already on its way has answered: its draft, or its last
   * save. Stops waiting once `signal` aborts. While that save has gone unanswered for a while,
   * `onUnreached` hears what failed each time.
   */
  last: (
    signal: AbortSignal,
    onUnreached: (error: unknown) => void,
  ) => Promise<MessageRef | LastSave>;
  /** Whom it goes to, as it was written. */
  to: readonly Address[];
  /** When to send, as an instant. A time inside the undo window sends when the window closes. */
  at: string | undefined;
  pressedAt: number;
  /** The Mailroom has the send, and the draft it sends. */
  onSent: (draft: MessageRef) => void;
  /**
   * Brings the message back to a composer, once Undo has stopped or taken back the send, as the
   * draft the Mailroom kept, if it filed one.
   */
  onUndone: (draft?: MessageRef) => void;
  /** The message couldn't be saved, or the Mailroom refused it, and why. */
  onFailed: (reason: string) => void;
};

/**
 * A press this device made, as its hand-off to the Mailroom goes on, how to stop that, which then
 * asks the Mailroom nothing more, and what this device has seen of its send in the Outbox.
 */
type HandOff = { press: Press; hand: Hand; stop: () => void; seen?: Followed };

/**
 * How a press reaches the Mailroom: any save of its message already on its way, then the asking,
 * which carries the last save and asks again until the Mailroom answers, then the send the Mailroom
 * scheduled. Undo stops it while it waits for the save, asks the Mailroom to stop it while it's
 * asked, and takes back the send once it is. While the save or the asking goes unanswered for a
 * while, `unreached` says what failed last.
 */
export type Hand =
  | { is: 'saving'; unreached?: string }
  | { is: 'asking'; answer: Promise<Answer | undefined>; unreached?: string }
  /**
   * Undo asked the Mailroom to stop a send it was still being asked for, which is asked for no more
   * until the Mailroom has `settled` that.
   */
  | {
      is: 'undoing';
      answer: Promise<Answer | undefined>;
      settled: Promise<void>;
      unreached?: string;
    }
  | { is: 'asked'; send: Outgoing }
  | { is: 'stopped' }
  | { is: 'failed' };

/** What the Mailroom answered a press: the send it scheduled, or why it refused. */
export type Answer = { send: Outgoing } | { refused: string };

let asked: ReadonlyMap<string, HandOff> = new Map();
const listeners = new Set<() => void>();

/** A press of Send, followed from the moment it's pressed, while its message's last save runs. */
export function pressed(press: Press, stop: () => void) {
  change(press.id, { press, hand: { is: 'saving' }, stop });
}

/** How a press's hand-off has gone on. One stopped asks the Mailroom nothing more. */
export function handed(id: string, hand: Hand) {
  const was = asked.get(id);
  if (!was) return;
  change(id, { ...was, hand });
  if (hand.is === 'stopped') was.stop();
}

/**
 * What this device has seen of a press's send in the Outbox, up to how it ended, as the workbench
 * follows it, which the press's toast reads wherever the member is.
 */
export function saw(id: string, seen: Followed) {
  const was = asked.get(id);
  if (was && was.seen !== seen) change(id, { ...was, seen });
}

/**
 * What failed when a press, or the save it waits for, last went unanswered, while it's still being
 * saved or asked for, or that an ask has landed.
 */
export function unreached(id: string, failed: string | undefined) {
  const was = asked.get(id);
  if (!was || !mayGoUnanswered(was.hand)) return;
  if (was.hand.unreached !== failed)
    change(id, { ...was, hand: { ...was.hand, unreached: failed } });
}

/**
 * What failed when a press still being saved or asked for last went unanswered, if it has for a
 * while.
 */
export const unreachedOf = (hand: Hand | undefined) =>
  hand && mayGoUnanswered(hand) ? hand.unreached : undefined;

const mayGoUnanswered = (hand: Hand) =>
  hand.is === 'saving' || hand.is === 'asking' || hand.is === 'undoing';

/** A press, as its hand-off stands now. */
export const askedFor = (id: string) => asked.get(id);

/**
 * When a send closes its undo window: if this device asked for it, on this device's clock, so its
 * line, its toast and its Outbox row count down alike, or else when the Mailroom says.
 */
export function closesFor(outgoing: Outgoing): number {
  const press = pressOf(outgoing)?.press;
  return press ? closesAfterPress(press.pressedAt, press.at) : closesAt(outgoing);
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/**
 * Every press, by its id, anew whenever this device asks for a send, which can be after a snapshot
 * of the Outbox has already brought it, as when the Mailroom's hint outruns its answer.
 */
export const useAllAsked = () => useSyncExternalStore(subscribe, () => asked);

/** A press, as its hand-off goes on. */
export const useAsked = (id: string) => useSyncExternalStore(subscribe, () => asked.get(id));

/**
 * The press that asked for a send, as its hand-off stands now, if this device asked for it. A press
 * names its send, unless the Mailroom held one of the same draft already.
 */
export function pressOf(outgoing: Outgoing): HandOff | undefined {
  const named = asked.get(outgoing.id);
  if (named) return named;
  for (const handOff of asked.values()) {
    if (handOff.hand.is === 'asked' && handOff.hand.send.id === outgoing.id) return handOff;
  }
  return undefined;
}

function change(id: string, handOff: HandOff) {
  asked = new Map(asked).set(id, handOff);
  holdPage(
    [...asked.values()].some(({ hand }) => ['saving', 'asking', 'undoing'].includes(hand.is)),
  );
  for (const listener of listeners) listener();
}

/**
 * While a press is on its way to the Mailroom, closing the page would lose it, so the browser asks
 * first. Only then, since a page that listens for unloading can't be kept for going back to.
 */
function holdPage(isHeld: boolean) {
  if (isHeld) window.addEventListener('beforeunload', ask);
  else window.removeEventListener('beforeunload', ask);
}

const ask = (event: BeforeUnloadEvent) => event.preventDefault();
