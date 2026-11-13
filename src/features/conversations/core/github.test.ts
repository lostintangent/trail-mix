import { describe, expect, test } from 'bun:test';
import type { GitHubThread } from '../../mail/core/index.ts';
import { chipFactOf, factsOf, numberOf } from './github.ts';

describe("a bundle row's chip", () => {
  test('leads with what asks the member to act, in ink only while unread', () => {
    const review = { kind: 'pull', reason: 'review_requested', outcome: 'failed' } as const;
    expect(chipFactOf({ ...review, unread: true })).toEqual({
      label: 'Review requested',
      asks: true,
    });
    expect(chipFactOf({ ...review, unread: false })).toEqual({
      label: 'Review requested',
      asks: false,
    });
  });

  test('says a failure before why GitHub wrote', () => {
    expect(
      chipFactOf({ kind: 'run', reason: 'ci_activity', outcome: 'failed', unread: true }),
    ).toEqual({ label: 'Run failed', asks: true });
    expect(
      chipFactOf({ kind: 'pull', reason: 'comment', outcome: 'failed', unread: false }),
    ).toEqual({ label: 'Checks failed', asks: false });
  });

  test('lets CI activity give way to how the run ended', () => {
    expect(
      chipFactOf({ kind: 'run', reason: 'ci_activity', outcome: 'passed', unread: true }),
    ).toEqual({ label: 'Run passed', asks: false });
  });

  test('falls back to the state, then the kind', () => {
    expect(chipFactOf({ kind: 'pull', state: 'merged', unread: false }).label).toBe('Merged');
    expect(chipFactOf({ kind: 'discussion', unread: true }).label).toBe('Discussion');
  });
});

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

describe("a thread's number", () => {
  test('is a run’s commit, never its id', () => {
    expect(numberOf({ kind: 'run', number: 9_876_543, commit: '4f2a9c1' })).toEqual({
      text: '4f2a9c1',
      isCommit: true,
    });
    expect(numberOf({ kind: 'run', number: 9_876_543 })).toBeUndefined();
  });

  test('is anything else’s number', () => {
    expect(numberOf({ kind: 'pull', number: 7 })).toEqual({ text: '#7', isCommit: false });
  });
});
