import { useQuery, useQueryClient } from '@tanstack/react-query';
import { RotateCw, Undo2 } from 'lucide-react';
import type { Command } from '../../commands/index.ts';
import type { MessageRef, Outgoing } from '../../mail/core/index.ts';
import { outboxQuery } from '../../mailroom/client/index.ts';
import { briefly } from '../core/standing.ts';
import { GROUP, isOnItsWay, sendCommands } from './sendCommands.ts';
import { useUndoable } from './undoable.ts';
import { loadSending, useSend } from './useSend.ts';

const NONE: readonly Outgoing[] = [];

/**
 * The Outbox's commands for the registry: Send and Send later for the draft open in the reader, if
 * one is, Undo send while this device's latest send can still be taken back, and Retry for each
 * send that failed. `undoSend` is the same undo, for a key the workbench shares with its own Undo.
 */
export function useOutboxCommands(draft: MessageRef | undefined): {
  commands: Command[];
  undoSend: (() => void) | undefined;
} {
  const send = useSend();
  const undoable = useUndoable();
  const outbox = useQuery(outboxQuery).data ?? NONE;
  const queryClient = useQueryClient();
  return {
    undoSend: undoable?.takeBack,
    commands: [
      ...(draft
        ? sendCommands({
            onSend: (at) => void send(draft, { at }),
            isEnabled: !isOnItsWay(outbox, draft),
          })
        : []),
      {
        id: 'outbox.undo',
        title: 'Undo send',
        group: GROUP,
        icon: Undo2,
        isEnabled: undoable !== undefined,
        run: () => undoable?.takeBack(),
      },
      ...outbox
        .filter(({ state, error }) => state === 'failed' || error !== undefined)
        .map((outgoing) => ({
          id: `outbox.retry:${outgoing.id}`,
          title: `Retry sending to ${briefly(outgoing.to)}`,
          group: GROUP,
          icon: RotateCw,
          run: async () => (await loadSending()).outboxActions(queryClient).retry(outgoing),
        })),
    ],
  };
}
