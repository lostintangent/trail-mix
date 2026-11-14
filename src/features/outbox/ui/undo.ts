import type { QueryClient } from '@tanstack/react-query';
import { reasonOf } from '../../../shared/reasons.ts';
import type { Outgoing } from '../../mail/core/index.ts';
import { mailroom, outboxQuery } from '../../mailroom/client/index.ts';
import { askedFor, closesFor, handed, pressOf } from './asked.ts';

// Undo for the sends this device asked for, which only a send's line and its toast offer, so it
// loads with them rather than with the first screen.

/**
 * Undo for a press: stops its hand-off while its message is still saving, which brings the message
 * back at once, or takes back its send once the Mailroom has it. Says why not if it couldn't.
 */
export async function undo(queryClient: QueryClient, id: string): Promise<string | undefined> {
  const press = askedFor(id);
  switch (press?.hand.is) {
    case 'saving':
      handed(id, { is: 'stopped' });
      press.stop();
      press.onUndone();
      return undefined;
    case 'asking': {
      const outgoing = await press.hand.answer;
      return outgoing && takeBack(queryClient, outgoing);
    }
    case 'asked':
      return takeBack(queryClient, press.hand.send);
    default:
      return undefined;
  }
}

/**
 * Takes a send back, and brings its message back if this device asked for it. Says why not if the
 * Mailroom refused: an Undo that reached it after the window closed was too late, whatever the send
 * has come to since, and anything else says the Mailroom's reason.
 */
export async function takeBack(
  queryClient: QueryClient,
  outgoing: Outgoing,
): Promise<string | undefined> {
  try {
    await mailroom.cancelSend(outgoing.id);
    queryClient.setQueryData(outboxQuery.queryKey, (held) =>
      held?.filter(({ id }) => id !== outgoing.id),
    );
    pressOf(outgoing)?.onUndone();
    return undefined;
  } catch (error) {
    void queryClient.invalidateQueries({ queryKey: outboxQuery.queryKey });
    return Date.now() >= closesFor(outgoing)
      ? 'Too late to undo.'
      : `Couldn’t undo. ${reasonOf(error)}`;
  }
}
