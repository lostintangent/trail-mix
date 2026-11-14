import type { QueryClient } from '@tanstack/react-query';
import { reasonOf } from '../../../shared/reasons.ts';
import type { MessageRef, Outgoing } from '../../mail/core/index.ts';
import { mailroom, outboxQuery } from '../../mailroom/client/index.ts';
import { askedFor, closesFor, handed, pressOf } from './asked.ts';

// Undo for the sends this device asked for, which only a send's line and its toast offer, so it
// loads with them rather than with the first screen.

/**
 * Undo for a press: stops its hand-off while a save of its message is still on its way, which
 * brings the message back at once, asks the Mailroom to stop it while it's being asked, or takes
 * back its send once the Mailroom has it. Says why not if it couldn't.
 */
export async function undo(queryClient: QueryClient, id: string): Promise<string | undefined> {
  const press = askedFor(id);
  switch (press?.hand.is) {
    case 'saving':
      handed(id, { is: 'stopped' });
      press.stop();
      press.onUndone();
      return undefined;
    case 'asking':
      return stop(queryClient, id, press.hand.answer);
    case 'asked':
      return takeBack(queryClient, press.hand.send);
    default:
      return undefined;
  }
}

/**
 * Asks the Mailroom to stop a send it is still being asked for, which it does by keeping the last
 * save the send carried as a draft and scheduling nothing. One the Mailroom hasn't heard of yet, or
 * has scheduled already, is taken back once the asking answers.
 */
async function stop(
  queryClient: QueryClient,
  id: string,
  answer: Promise<Outgoing | undefined>,
): Promise<string | undefined> {
  handed(id, { is: 'undoing', answer });
  let draft: MessageRef;
  try {
    draft = await mailroom.cancelSend(id);
  } catch {
    const outgoing = await answer;
    if (outgoing) {
      handed(id, { is: 'asked', send: outgoing });
      return takeBack(queryClient, outgoing);
    }
    // The Mailroom refused the send itself, so nothing was scheduled.
    handed(id, { is: 'stopped' });
    askedFor(id)?.onUndone();
    return undefined;
  }
  handed(id, { is: 'stopped' });
  queryClient.setQueryData(outboxQuery.queryKey, (held) => held?.filter((each) => each.id !== id));
  askedFor(id)?.onUndone(draft);
  return undefined;
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
    const draft = await mailroom.cancelSend(outgoing.id);
    queryClient.setQueryData(outboxQuery.queryKey, (held) =>
      held?.filter(({ id }) => id !== outgoing.id),
    );
    const press = pressOf(outgoing);
    if (press && press.hand.is !== 'stopped') {
      handed(press.id, { is: 'stopped' });
      press.onUndone(draft);
    }
    return undefined;
  } catch (error) {
    void queryClient.invalidateQueries({ queryKey: outboxQuery.queryKey });
    return Date.now() >= closesFor(outgoing)
      ? 'Too late to undo.'
      : `Couldn’t undo. ${reasonOf(error)}`;
  }
}
