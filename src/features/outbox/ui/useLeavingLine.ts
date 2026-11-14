import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useCommands } from '../../commands/index.ts';
import type { Leaving } from '../core/leaving.ts';
import { formatAhead } from '../core/later.ts';
import { isUndoable, type Standing } from '../core/standing.ts';
import { isAsked, useAskedVersion } from './asked.ts';
import { takeBack, undo as undoPress } from './undo.ts';
import { offerUndo } from './undoable.ts';
import { useLeavingStanding } from './useLeaving.ts';

/** What a send's line in its conversation says, and the one thing it offers to do. */
export type LeavingLine = {
  standing: Standing;
  /** Where it stands, in the place its copy's time will take. */
  said: string;
  /** Why it hasn't gone, or why Undo didn't take it back, beneath. */
  reason?: string;
  action?: { label: 'Undo' | 'Open Outbox'; run: () => void; isBusy: boolean };
  /** What assistive tech hears as it changes. Its countdown's seconds aren't announced. */
  told: string;
};

/**
 * A send followed to the end of its conversation, as its line there tells it while the member is
 * on that conversation: its countdown with Undo, the time it goes, that it's sending or went, or
 * why it didn't with the way to the Outbox. Undo pressed before the Mailroom has the send stops it,
 * or takes it back once the Mailroom does, and Undo's key reaches a send this device asked for
 * while it counts.
 */
export function useLeavingLine(leaving: Leaving): LeavingLine {
  const queryClient = useQueryClient();
  const standing = useLeavingStanding(leaving);
  const [undo, setUndo] = useState<'idle' | 'asking' | { refused: string }>('idle');
  const outgoing = leaving.seen?.last;

  // A press of this device's that the Mailroom doesn't have yet stops, or is taken back once it
  // does.
  const press = async () => {
    if (undo !== 'idle') return;
    setUndo('asking');
    const refused = outgoing
      ? await takeBack(queryClient, outgoing)
      : await undoPress(queryClient, leaving.id);
    if (refused !== undefined) setUndo({ refused });
  };

  useAskedVersion();
  const isMine = isAsked(leaving.id);
  const canTakeBack = isUndoable(standing) && undo === 'idle';
  const latestPress = useRef(press);
  useLayoutEffect(() => {
    latestPress.current = press;
  });
  useEffect(() => {
    if (!canTakeBack || !isMine) return;
    return offerUndo({ id: leaving.id, takeBack: () => void latestPress.current() });
  }, [canTakeBack, isMine, leaving.id]);

  const goToOutbox = useCommands().find((command) => command.id === 'go.outbox');
  const refused = typeof undo === 'object' ? undo.refused : undefined;
  const { said, reason: why } = saidOf(standing);
  const reason = [refused, why].filter(Boolean).join(' ') || undefined;
  const action: LeavingLine['action'] = isUndoable(standing)
    ? { label: 'Undo', run: () => void press(), isBusy: undo === 'asking' }
    : goToOutbox && (standing.is === 'failed' || standing.is === 'retrying')
      ? { label: 'Open Outbox', run: () => void goToOutbox.run(), isBusy: false }
      : undefined;
  const told = useTold(standing, reason);
  return { standing, said, ...(reason && { reason }), ...(action && { action }), told };
}

/** What a line says for where its send stands, and why it hasn't gone, if it hasn't. */
function saidOf(standing: Standing): { said: string; reason?: string } {
  switch (standing.is) {
    case 'counting':
      return { said: `Sending in ${standing.seconds}s` };
    case 'scheduled':
      return { said: formatAhead(standing.at) };
    case 'sending':
      return { said: 'Sending…' };
    case 'sent':
      return { said: 'Sent' };
    case 'retrying':
      return { said: 'Not sent yet', reason: `${standing.error} Trying again.` };
    case 'failed':
      return { said: 'Couldn’t send', reason: standing.error };
    case 'undone':
      return { said: 'Undone' };
  }
}

/**
 * What a line announces, once for each change in where its send stands or why: a countdown as it
 * begins, rather than each second of it.
 */
function useTold(standing: Standing, reason: string | undefined): string {
  const key = `${standing.is}\u0000${reason ?? ''}`;
  const text =
    standing.is === 'counting'
      ? `Sending in ${standing.seconds} seconds.`
      : [`${saidOf(standing).said}.`, reason].filter(Boolean).join(' ');
  const [told, setTold] = useState({ key, text });
  if (told.key !== key) setTold({ key, text });
  return told.text;
}
