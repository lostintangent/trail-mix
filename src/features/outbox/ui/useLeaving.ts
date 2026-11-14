import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import type { MessageRef, Outgoing } from '../../mail/core/index.ts';
import { outboxQuery } from '../../mailroom/client/index.ts';
import {
  draftsLeaving,
  expire,
  forget,
  named as nameDraft,
  nextExpiry,
  observe,
  press,
  standingOfLeaving,
  type Leaving,
  type Pressed,
} from '../core/leaving.ts';
import { closesFor, saw } from './asked.ts';
import { useWakeAt } from './clock.ts';

/** How often the Outbox is asked again while a send is under way, in case a hint is lost. */
const CHECK_MS = 2_000;

/**
 * The sends this device follows to the ends of their conversations, and their drafts, which
 * conversations leave out. A press of Send puts its reply in place in the same frame that closes its
 * composer, and each snapshot of the Outbox moves every send on.
 */
export function useLeaving() {
  const [held, setHeld] = useState<{
    outbox?: readonly Outgoing[];
    /** Every send the last snapshot showed, those it ended included. */
    observed: readonly Leaving[];
    all: readonly Leaving[];
  }>({ observed: [], all: [] });
  const isUnderWay = useIsUnderWay(held.all);
  const { data: outbox, dataUpdatedAt } = useQuery({
    ...outboxQuery,
    refetchInterval: isUnderWay ? CHECK_MS : false,
  });
  // Each snapshot is folded in the render that brings it, so nothing shows it half taken in, and
  // one that ends a send lets it go at once.
  if (outbox && outbox !== held.outbox) {
    const observed = observe(held.all, outbox, dataUpdatedAt, closesFor);
    setHeld({ outbox, observed, all: expire(observed, dataUpdatedAt) });
  }
  const { observed, all } = held;
  // Each press this device made sees its send as the workbench does, up to how it ended, for its
  // toast.
  useEffect(() => {
    for (const { id, seen } of observed) if (seen) saw(id, seen);
  }, [observed]);

  // A send gone from the Outbox waits only so long for its copy.
  useWakeAt(nextExpiry(all), (now) => setHeld((was) => ({ ...was, all: expire(was.all, now) })));

  const changes = useMemo(() => {
    const change = (to: (all: readonly Leaving[]) => readonly Leaving[]) =>
      setHeld((was) => ({ ...was, all: to(was.all) }));
    return {
      /** A press of Send, with the draft its message was last saved as, if it has been. */
      pressed: (sent: Pressed) => change((all) => press(all, sent)),
      /** A press's message, saved again on its way to the Mailroom. */
      named: (id: string, draft: MessageRef) => change((all) => nameDraft(all, id, draft)),
      /** Stops following a press, as when its send failed or this device took it back. */
      forgotten: (id: string) => change((all) => forget(all, id)),
    };
  }, []);
  const drafts = useMemo(() => draftsLeaving(all), [all]);
  return { all, drafts, ...changes };
}

/**
 * Whether any send followed is under way, as far as the Outbox has said: due, begun, or set to try
 * again, and not yet seen gone. Each window that closes makes one due, so it looks again then.
 */
function useIsUnderWay(all: readonly Leaving[]): boolean {
  const [now, setNow] = useState(Date.now);
  const next = Math.min(...all.map(({ closes }) => closes).filter((closes) => closes > now));
  useWakeAt(Number.isFinite(next) ? next : undefined, setNow);
  return all.some(
    (leaving) =>
      leaving.seen?.goneAt === undefined &&
      ['sending', 'retrying'].includes(standingOfLeaving(leaving, now).is),
  );
}
