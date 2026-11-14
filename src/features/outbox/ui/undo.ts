import type { QueryClient } from '@tanstack/react-query';
import { reasonOf } from '../../../shared/reasons.ts';
import type { MessageRef, Outgoing } from '../../mail/core/index.ts';
import { mailroom, outboxQuery, untilAnswered, whatFailed } from '../../mailroom/client/index.ts';
import { askedFor, closesFor, handed, pressOf, unreached, type Hand } from './asked.ts';

// Undo for the sends this device asked for, which only a send's line and its toast offer, so it
// loads with them rather than with the first screen.

/**
 * Undo for a press: stops its hand-off while a save of its message is still on its way, which
 * brings the message back at once, asks the Mailroom to stop it while it's being asked, or takes
 * back its send once the Mailroom has it. Asks again until the Mailroom answers, and says why not if
 * it couldn't.
 */
export async function undo(queryClient: QueryClient, id: string): Promise<string | undefined> {
  const press = askedFor(id);
  switch (press?.hand.is) {
    case 'saving':
      handed(id, { is: 'stopped' });
      press.onUndone();
      return undefined;
    case 'asking':
      return stop(queryClient, id, press.hand);
    case 'asked':
      return takeBack(queryClient, press.hand.send);
    default:
      return undefined;
  }
}

/**
 * Asks the Mailroom to stop a send it is still being asked for, which it does whether it has
 * scheduled the send, is filing its last save, which it keeps as a draft, or has yet to hear of it,
 * which then it never will. Once the Mailroom refuses, as when the send has gone, the asking's own
 * answer says what came of the press: the send to follow, or why it was refused, with the message
 * back.
 */
async function stop(
  queryClient: QueryClient,
  id: string,
  asking: Extract<Hand, { is: 'asking' }>,
): Promise<string | undefined> {
  const { promise: settled, resolve: settle } = Promise.withResolvers<void>();
  handed(id, { ...asking, is: 'undoing', settled });
  let draft: MessageRef | undefined;
  try {
    draft = await untilAnswered(() => mailroom.cancelSend(id), {
      onUnreached: (error) => unreached(id, whatFailed(error)),
    });
  } catch (error) {
    settle();
    const answer = await asking.answer;
    if (answer && 'send' in answer) {
      handed(id, { is: 'asked', send: answer.send });
      void queryClient.invalidateQueries({ queryKey: outboxQuery.queryKey });
      return refusalOf(answer.send, error);
    }
    const press = askedFor(id);
    if (answer) {
      handed(id, { is: 'failed' });
      press?.onFailed(answer.refused);
    } else {
      handed(id, { is: 'stopped' });
      press?.onUndone();
    }
    return undefined;
  }
  const press = askedFor(id);
  handed(id, { is: 'stopped' });
  settle();
  queryClient.setQueryData(outboxQuery.queryKey, (held) => held?.filter((each) => each.id !== id));
  press?.onUndone(draft);
  return undefined;
}

/**
 * Takes a send back, asking again until the Mailroom answers, and brings its message back if this
 * device asked for it. Says why not if the Mailroom refused: an Undo that reached it after the
 * window closed was too late, whatever the send has come to since, and anything else says the
 * Mailroom's reason.
 */
export async function takeBack(
  queryClient: QueryClient,
  outgoing: Outgoing,
): Promise<string | undefined> {
  try {
    const draft = await untilAnswered(() => mailroom.cancelSend(outgoing.id));
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
    return refusalOf(outgoing, error);
  }
}

/** Why the Mailroom refused to take a send back. */
const refusalOf = (outgoing: Outgoing, error: unknown) =>
  Date.now() >= closesFor(outgoing) ? 'Too late to undo.' : `Couldn’t undo. ${reasonOf(error)}`;
