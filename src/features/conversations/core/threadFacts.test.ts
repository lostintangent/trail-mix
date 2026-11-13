import { describe, expect, test } from 'bun:test';
import type { GitHubThread } from '../../mail/core/index.ts';
import { factsOf } from './threadFacts.ts';

describe("a thread's facts", () => {
  const thread: GitHubThread = {
    repository: 'octo/app',
    kind: 'pull',
    number: 7,
    title: 'Faster sync',
    outcome: 'failed',
    state: 'closed',
    reasons: ['review_requested', 'comment', 'ci_activity'],
  };

  test('list what asks, then a failure, then the rest, then the state', () => {
    expect(factsOf(thread, true)).toEqual([
      { label: 'Review requested', asks: true },
      { label: 'Checks failed', asks: true },
      { label: 'Comment', asks: false },
      { label: 'Closed', asks: false },
    ]);
  });

  test('ask nothing once read', () => {
    expect(factsOf(thread, false).some(({ asks }) => asks)).toBe(false);
  });

  test('keep CI activity when no outcome says more', () => {
    const quiet: GitHubThread = {
      repository: 'octo/app',
      kind: 'run',
      title: 'CI',
      reasons: ['ci_activity'],
    };
    expect(factsOf(quiet, true)).toEqual([{ label: 'CI activity', asks: false }]);
  });

  test('put a passed run after the reasons', () => {
    const passed: GitHubThread = { ...thread, outcome: 'passed', state: undefined };
    expect(factsOf(passed, true).map(({ label }) => label)).toEqual([
      'Review requested',
      'Comment',
      'Checks passed',
    ]);
  });
});
