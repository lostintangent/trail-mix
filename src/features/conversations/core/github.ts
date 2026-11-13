import {
  asks,
  isAsking,
  type BundleChip,
  type GitHubKind,
  type GitHubReason,
  type GitHubThread,
} from '../../mail/core/index.ts';

/**
 * What a chip says of a GitHub thread, in words, and whether it asks something of the member, which
 * ink alone shows, never the accent or the highlighter.
 */
export type Fact = { label: string; asks: boolean };

/**
 * The one fact a bundle's row says of a thread: what it asks of the member, or a run or checks that
 * failed, then why GitHub wrote, how its run or checks ended, whether it was merged or closed, and
 * failing all of those, what it is.
 */
export function chipFactOf(chip: BundleChip): Fact {
  const { kind, reason, outcome, state } = chip;
  const asking = asks(chip);
  if (reason !== undefined && isAsking(reason)) return { label: REASONS[reason], asks: asking };
  if (outcome === 'failed') return { label: endedAs(kind, outcome), asks: asking };
  if (reason !== undefined && reason !== 'ci_activity')
    return { label: REASONS[reason], asks: false };
  if (outcome !== undefined) return { label: endedAs(kind, outcome), asks: false };
  if (state !== undefined) return { label: STATES[state], asks: false };
  return { label: KINDS[kind], asks: false };
}

/**
 * How a thread is numbered beside its title: a run by its commit, set in monospace, and anything
 * else by its number. A run's own id means nothing to a reader, so it is left out.
 */
export function numberOf({
  kind,
  number,
  commit,
}: Pick<GitHubThread, 'kind' | 'number' | 'commit'>):
  { text: string; isCommit: boolean } | undefined {
  if (kind === 'run') return commit === undefined ? undefined : { text: commit, isCommit: true };
  return number === undefined ? undefined : { text: `#${number}`, isCommit: false };
}

/** How a run, or the checks on a pull request, ended. */
export const endedAs = (kind: GitHubKind, outcome: NonNullable<GitHubThread['outcome']>) =>
  `${kind === 'run' ? 'Run' : 'Checks'} ${outcome}`;

/** What each kind of thread is called. */
export const KINDS: Record<GitHubKind, string> = {
  pull: 'Pull request',
  issue: 'Issue',
  discussion: 'Discussion',
  run: 'Run',
};

/** Why GitHub wrote, as its documentation names each reason. */
export const REASONS: Record<GitHubReason, string> = {
  assign: 'Assigned',
  author: 'Author',
  ci_activity: 'CI activity',
  comment: 'Comment',
  manual: 'Subscribed',
  mention: 'Mention',
  push: 'Push',
  review_requested: 'Review requested',
  security_alert: 'Security alert',
  state_change: 'State change',
  subscribed: 'Subscribed',
  team_mention: 'Team mention',
  your_activity: 'Your activity',
};

/** What became of a pull request or an issue. */
export const STATES: Record<NonNullable<GitHubThread['state']>, string> = {
  merged: 'Merged',
  closed: 'Closed',
};
