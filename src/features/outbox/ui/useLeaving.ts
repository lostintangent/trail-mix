import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ConversationId, MessageRef, Outgoing } from '../../mail/core/index.ts';
import { outboxQuery } from '../../mailroom/client/index.ts';
import {
  draftsAway,
  expire,
  forget,
  nextExpiry,
  observe,
  press,
  standingOfLeaving,
  type Leaving,
} from '../core/leaving.ts';
import { UNDO_SECONDS } from '../core/outbox.ts';
import type { Standing } from '../core/standing.ts';
import { closesFor } from './closings.ts';

/**
 * The sends this device follows to the ends of their conversations, and the drafts on their way,
 * which conversations leave out. A press of Send puts its reply in place in the same frame that
 * closes its composer, and each snapshot of the Outbox moves every send on.
 */
export function useLeaving() {
  const { data: outbox, dataUpdatedAt } = useQuery(outboxQuery);
  const [held, setHeld] = useState<{ outbox?: readonly Outgoing[]; all: readonly Leaving[] }>({
    all: [],
  });
  // Each snapshot is folded in the render that brings it, so nothing shows it half taken in.
  if (outbox && outbox !== held.outbox) {
    setHeld({ outbox, all: observe(held.all, outbox, dataUpdatedAt, closesFor) });
  }
  const { all } = held;

  // A send gone from the Outbox waits only so long for its copy.
  useEffect(() => {
    const ends = nextExpiry(all);
    if (ends === undefined) return;
    const timer = setTimeout(
      () => {
        const now = Date.now();
        setHeld((was) => ({ ...was, all: expire(was.all, now) }));
      },
      Math.max(0, ends - Date.now()) + 1,
    );
    return () => clearTimeout(timer);
  }, [all]);

  const pressed = useCallback(
    (
      draft: MessageRef,
      sent: {
        in: ConversationId | undefined;
        written: string;
        at: string | undefined;
        pressedAt: number;
      },
    ) => {
      const { pressedAt } = sent;
      setHeld((was) => ({
        ...was,
        all: press(was.all, {
          draft,
          pressedIn: sent.in,
          written: sent.written,
          pressedAt,
          at: sent.at,
        }),
      }));
    },
    [],
  );
  /** Stops following a send, as when the Mailroom refused it or this device took it back. */
  const forgotten = useCallback(
    (draft: MessageRef) => setHeld((was) => ({ ...was, all: forget(was.all, draft) })),
    [],
  );
  const drafts = useMemo(() => draftsAway(all), [all]);
  return { all, drafts, pressed, forgotten };
}

/**
 * Where a reply on its way stands, now. The one change time makes to it is the end of a wait for a
 * later time, when its countdown begins: the rest come with the Outbox's snapshots.
 */
export function useLeavingStanding(leaving: Leaving): Standing {
  const [now, setNow] = useState(Date.now);
  const standing = standingOfLeaving(leaving, now);
  const isWaiting = standing.is === 'scheduled';
  useEffect(() => {
    if (!isWaiting) return;
    const counts = leaving.closes - UNDO_SECONDS * 1000;
    const timer = setTimeout(() => setNow(Date.now()), Math.max(0, counts - Date.now()) + 1);
    return () => clearTimeout(timer);
  }, [isWaiting, leaving.closes]);
  return standing;
}
