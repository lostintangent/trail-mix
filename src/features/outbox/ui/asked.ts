import { useSyncExternalStore } from 'react';
import type { Outgoing } from '../../mail/core/index.ts';
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
  /** Brings the message back to a composer, once Undo has stopped or taken back its send. */
  onUndone: () => void;
  /** Stops the hand-off before it asks the Mailroom. */
  stop: () => void;
};

/**
 * How a press reaches the Mailroom: its message's last save, then the asking, then the send the
 * Mailroom scheduled. Undo stops it while it saves, or takes back the send once it is asked.
 */
export type Hand =
  | { is: 'saving' }
  | { is: 'asking'; answer: Promise<Outgoing | undefined> }
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

/** The press that asked for a send, if this device asked for it. */
export const pressOf = (outgoing: Outgoing) =>
  [...asked.values()].find(({ hand }) => hand.is === 'asked' && hand.send.id === outgoing.id);

function change(id: string, press: Asked) {
  asked = new Map(asked).set(id, press);
  version++;
  holdPage([...asked.values()].some(({ hand }) => hand.is === 'saving' || hand.is === 'asking'));
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
