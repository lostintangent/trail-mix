import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Address, ConversationId, MessageRef, Outgoing } from '../../mail/core/index.ts';
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
} from '../core/leaving.ts';
import { UNDO_SECONDS } from '../core/outbox.ts';
import type { Standing } from '../core/standing.ts';
import { closesFor } from './asked.ts';

/** How often the Outbox is asked again while a send is under way, in case a hint is lost. */
const CHECK_MS = 2_000;

/**
 * The sends this device follows to the ends of their conversations, and their drafts, which
 * conversations leave out. A press of Send puts its reply in place in the same frame that closes its
 * composer, and each snapshot of the Outbox moves every send on.
 */
export function useLeaving() {
  const [held, setHeld] = useState<{ outbox?: readonly Outgoing[]; all: readonly Leaving[] }>({
    all: [],
  });
  const isUnderWay = useIsUnderWay(held.all);
  const { data: outbox, dataUpdatedAt } = useQuery({
    ...outboxQuery,
    refetchInterval: isUnderWay ? CHECK_MS : false,
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

  /** A press of Send, with the draft its message was last saved as, if it has been. */
  const pressed = useCallback(
    (
      id: string,
      sent: {
        draft: MessageRef | undefined;
        in: ConversationId | undefined;
        written: string;
        to: readonly Address[];
        at: string | undefined;
        pressedAt: number;
      },
    ) => {
      setHeld((was) => ({
        ...was,
        all: press(was.all, {
          id,
          draft: sent.draft,
          pressedIn: sent.in,
          written: sent.written,
          to: sent.to,
          pressedAt: sent.pressedAt,
          at: sent.at,
        }),
      }));
    },
    [],
  );
  /** A press's message, saved again on its way to the Mailroom. */
  const named = useCallback(
    (id: string, draft: MessageRef) =>
      setHeld((was) => ({ ...was, all: nameDraft(was.all, id, draft) })),
    [],
  );
  /** Stops following a press, as when its send failed or this device took it back. */
  const forgotten = useCallback(
    (id: string) => setHeld((was) => ({ ...was, all: forget(was.all, id) })),
    [],
  );
  const drafts = useMemo(() => draftsLeaving(all), [all]);
  return { all, drafts, pressed, named, forgotten };
}

/** The sends this device follows, the drafts they hold, and how a press, a save or a failure moves them. */
export type LeavingSends = ReturnType<typeof useLeaving>;

/**
 * Whether any send followed is under way, as far as the Outbox has said: due, begun, or set to try
 * again, and not yet seen gone. Each window that closes makes one due, so it looks again then.
 */
function useIsUnderWay(all: readonly Leaving[]): boolean {
  const [now, setNow] = useState(Date.now);
  const next = Math.min(...all.map(({ closes }) => closes).filter((closes) => closes > now));
  useEffect(() => {
    if (!Number.isFinite(next)) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.max(0, next - Date.now()) + 1);
    return () => clearTimeout(timer);
  }, [next]);
  return all.some(
    (leaving) =>
      leaving.seen?.goneAt === undefined &&
      ['sending', 'retrying'].includes(standingOfLeaving(leaving, now).is),
  );
}

/**
 * Where a send followed stands, now: its countdown turns over each second on time, and a wait for a
 * later time ends when its countdown begins. The rest come with the Outbox's snapshots.
 */
export function useLeavingStanding(leaving: Leaving): Standing {
  const [now, setNow] = useState(Date.now);
  const standing = standingOfLeaving(leaving, now);
  const isWaiting = standing.is === 'scheduled';
  const isCounting = standing.is === 'counting';
  useEffect(() => {
    if (!isWaiting) return;
    const counts = leaving.closes - UNDO_SECONDS * 1000;
    const timer = setTimeout(() => setNow(Date.now()), Math.max(0, counts - Date.now()) + 1);
    return () => clearTimeout(timer);
  }, [isWaiting, leaving.closes]);
  useEffect(() => {
    if (!isCounting) return;
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, [isCounting]);
  return standing;
}

/** How often a countdown looks at the clock, so each second turns over on time. */
const TICK_MS = 250;
