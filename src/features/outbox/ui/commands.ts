import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { Command } from '../../commands/index.ts';
import type { Outgoing } from '../../mail/core/index.ts';
import { outboxQuery } from '../../mailroom/client/index.ts';
import { briefly } from '../core/standing.ts';
import { useUndoable } from './undoable.ts';
import { loadSending } from './useSend.ts';

/** Where the palette lists sending, and taking a send back. */
export const GROUP = 'Send';

const NONE: readonly Outgoing[] = [];

/**
 * The Outbox's commands for the registry: Undo send while this device's latest send can still be
 * taken back, and Retry for each send that failed. `undoSend` is the same undo, for a key the
 * workbench shares with its own Undo. The composer brings Send and Send later.
 */
export function useOutboxCommands(): {
  commands: Command[];
  undoSend: (() => void) | undefined;
} {
  const undoable = useUndoable();
  const outbox = useQuery(outboxQuery).data ?? NONE;
  const queryClient = useQueryClient();
  return {
    undoSend: undoable?.takeBack,
    commands: [
      {
        id: 'outbox.undo',
        title: 'Undo send',
        group: GROUP,
        menuIcon: 'undo',
        isEnabled: undoable !== undefined,
        run: () => undoable?.takeBack(),
      },
      ...outbox
        .filter(({ state, error }) => state === 'failed' || error !== undefined)
        .map((outgoing): Command => ({
          id: `outbox.retry:${outgoing.id}`,
          title: `Retry sending to ${briefly(outgoing.to)}`,
          group: GROUP,
          menuIcon: 'rotateCw',
          run: async () => (await loadSending()).outboxActions(queryClient).retry(outgoing),
        })),
    ],
  };
}
