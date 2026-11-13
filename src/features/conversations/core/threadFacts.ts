import { isAsking, type GitHubReason, type GitHubThread } from '../../mail/core/index.ts';
import { endedAs, REASONS, STATES, type Fact } from './github.ts';

// Only a bundle's sheet, which loads when a bundle is first opened, says all of a thread's facts, so
// they lie apart from the words a bundle's row needs on the first screen.

/**
 * Everything a thread's sheet says of it, in the row's order: the reasons that ask something of the
 * member and a failure first, then the other reasons, how its run or checks ended, and whether it
 * was merged or closed. CI activity says no more than the outcome beside it, so it gives way to it.
 * Only an unread thread asks.
 */
export function factsOf(thread: GitHubThread, isUnread: boolean): Fact[] {
  const { kind, reasons, outcome, state } = thread;
  const said = reasons.filter((reason) => reason !== 'ci_activity' || outcome === undefined);
  const reason = (each: GitHubReason): Fact => ({
    label: REASONS[each],
    asks: isUnread && isAsking(each),
  });
  const ended = (failed: boolean): Fact[] =>
    outcome !== undefined && (outcome === 'failed') === failed
      ? [{ label: endedAs(kind, outcome), asks: isUnread && failed }]
      : [];
  return [
    ...said.filter(isAsking).map(reason),
    ...ended(true),
    ...said.filter((each) => !isAsking(each)).map(reason),
    ...ended(false),
    ...(state === undefined ? [] : [{ label: STATES[state], asks: false }]),
  ];
}
