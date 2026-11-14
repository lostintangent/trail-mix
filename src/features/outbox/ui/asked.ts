import { useSyncExternalStore } from 'react';
import type { MessageRef, Outgoing } from '../../mail/core/index.ts';
import { closesAt } from '../core/standing.ts';

/**
 * The sends this device asked for, each by its press: when its undo window closes on this device's
 * clock, so its line, its toast and its Outbox row count down alike, how its hand-off to the
 * Mailroom is going, and what Undo brings back. A send asked for elsewhere trusts this device's
 * clock.
 */
export type Asked = {
  closes: number;
  hand: Hand;
  /**
   * Brings the message back to a composer, once Undo has stopped or taken back its send, as the
   * draft the Mailroom kept, if it filed one.
   */
  onUndone: (draft?: MessageRef) => void;
  /** Stops the hand-off before it asks the Mailroom. */
  stop: () => void;
};

/**
 * How a press reaches the Mailroom: any save of its message already on its way, then the asking,
 * which carries the last save, then the send the Mailroom scheduled. Undo stops it while it waits
 * for the save, asks the Mailroom to stop it while it's asked, and takes back the send once it is.
 */
export type Hand =
  | { is: 'saving' }
  | { is: 'asking'; answer: Promise<Outgoing | undefined> }
  /** Undo asked the Mailroom to stop a send it was still being asked for. */
  | { is: 'undoing'; answer: Promise<Outgoing | undefined> }
  | { is: 'asked'; send: Outgoing }
  | { is: 'stopped' }
  | { is: 'failed' };

let asked: ReadonlyMap<string, Asked> = new Map();
const listeners = new Set<() => void>();
let version = 0;

/** A press of Send, followed from the moment it's pressed, while its message's last save runs. */
export function pressed(id: string, press: Omit<Asked, 'hand'>) {
  change(id, { ...press, hand: { is: 'saving' } });
}

/** How a press's hand-off has gone on. */
export function handed(id: string, hand: Hand) {
  const was = asked.get(id);
  if (was) change(id, { ...was, hand });
}

export const isAsked = (id: string) => asked.has(id);

/** A press, as its hand-off stands now. */
export const askedFor = (id: string) => asked.get(id);

/** When a send this device asked for closes its undo window here, or else when the Mailroom says. */
export function closesFor(outgoing: Outgoing): number {
  return pressOf(outgoing)?.closes ?? closesAt(outgoing);
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/**
 * Changes whenever this device asks for a send, which can be after a snapshot of the Outbox has
 * already brought it, as when the Mailroom's hint outruns its answer.
 */
export const useAskedVersion = () => useSyncExternalStore(subscribe, () => version);

/** A press, as its hand-off goes on. */
export const useAsked = (id: string) => useSyncExternalStore(subscribe, () => asked.get(id));

/**
 * The press that asked for a send, and its id, if this device asked for it. A press names its send,
 * unless the Mailroom held one of the same draft already.
 */
export function pressOf(outgoing: Outgoing): (Asked & { id: string }) | undefined {
  const named = asked.get(outgoing.id);
  if (named) return { ...named, id: outgoing.id };
  for (const [id, press] of asked) {
    if (press.hand.is === 'asked' && press.hand.send.id === outgoing.id) return { ...press, id };
  }
  return undefined;
}

function change(id: string, press: Asked) {
  asked = new Map(asked).set(id, press);
  version++;
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
