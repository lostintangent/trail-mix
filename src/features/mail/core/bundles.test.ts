import { describe, expect, test } from 'bun:test';
import {
  BUNDLE_CHIPS,
  bundleIdOf,
  bundlePartsOf,
  bundleSummaryOf,
  repositoryAddressOf,
  threadAddressOf,
} from './bundles.ts';
import { partsOf } from './conversations.ts';
import type { ConversationSummary, GitHubThread } from './model.ts';

describe('bundles', () => {
  test('a bundle is named by its account and repository, whatever their case', () => {
    const id = bundleIdOf('a:b/c', 'TrailMix-Demo/Toy-Box');
    expect(id).toBe(bundleIdOf('a:b/c', 'trailmix-demo/toy-box'));
    expect(bundlePartsOf(id)).toEqual({ account: 'a:b/c', repository: 'trailmix-demo/toy-box' });
  });

  test('a bundle id never reads as a conversation, nor a conversation’s as a bundle', () => {
    expect(partsOf(bundleIdOf('personal', 'o/r'))).toBeUndefined();
    expect(bundlePartsOf('personal::%3Co%2Fr%2Fpull%2F1%40github.com%3E')).toBeUndefined();
  });

  test('a bundle id naming no repository GitHub allows is none', () => {
    for (const repository of ['o', 'o/r/s', 'o/..', '-o/r', '']) {
      expect(bundlePartsOf(`personal:${encodeURIComponent(repository)}`)).toBeUndefined();
    }
    expect(bundlePartsOf(`:${encodeURIComponent('o/r')}`)).toBeUndefined();
    expect(bundlePartsOf('personal:o%2')).toBeUndefined();
  });

  const thread = (github: Partial<GitHubThread>, init: Partial<ConversationSummary> = {}) => ({
    id: `c${Math.random()}`,
    account: 'personal',
    subject: '',
    senders: [],
    recipients: [],
    preview: '',
    date: '2026-11-13T09:00:00.000Z',
    count: 1,
    unread: 0,
    flagged: false,
    hasAttachments: false,
    ...init,
    github: {
      repository: 'trailmix-demo/toy-box',
      kind: 'pull' as const,
      title: 'T',
      reasons: [],
      ...github,
    },
  });

  test('its row counts its threads and their messages, and is placed by its newest', () => {
    const newest = thread(
      { number: 12, title: 'Replayable stream cursors', reasons: ['comment'] },
      { date: '2026-11-13T09:41:00.000Z', count: 2, unread: 2, avatar: 'abc' },
    );
    const older = thread(
      { kind: 'issue', number: 9, state: 'closed' },
      { count: 3, flagged: true },
    );
    expect(bundleSummaryOf('personal:trailmix-demo%2Ftoy-box', [newest, older])).toEqual({
      kind: 'bundle',
      id: 'personal:trailmix-demo%2Ftoy-box',
      account: 'personal',
      repository: 'trailmix-demo/toy-box',
      date: '2026-11-13T09:41:00.000Z',
      newest: { kind: 'pull', number: 12, title: 'Replayable stream cursors' },
      threads: 2,
      count: 5,
      unread: 2,
      flagged: true,
      chips: [
        { kind: 'pull', reason: 'comment', unread: true },
        { kind: 'issue', state: 'closed', unread: false },
      ],
      avatar: 'abc',
    });
  });

  test('its chips put the unread threads that ask something first, then the rest newest first', () => {
    const chipsOf = (...threads: ReturnType<typeof thread>[]) =>
      bundleSummaryOf('b', threads)!.chips.map(({ reason, outcome }) => reason ?? outcome);
    expect(
      chipsOf(
        thread({ reasons: ['comment'] }, { unread: 1 }),
        thread({ reasons: ['review_requested'] }),
        thread({ kind: 'run', outcome: 'failed', reasons: [] }, { unread: 1 }),
        thread({ reasons: ['subscribed'] }),
        thread({ reasons: ['mention'] }, { unread: 1 }),
      ),
    ).toEqual(['failed', 'mention', 'comment', 'review_requested', 'subscribed']);
  });

  test(`its row carries at most ${BUNDLE_CHIPS} chips`, () => {
    const many = Array.from({ length: BUNDLE_CHIPS + 5 }, () => thread({}));
    expect(bundleSummaryOf('b', many)).toMatchObject({ threads: BUNDLE_CHIPS + 5 });
    expect(bundleSummaryOf('b', many)!.chips).toHaveLength(BUNDLE_CHIPS);
  });

  test('a bundle of nothing has no row', () => {
    expect(bundleSummaryOf('b', [])).toBeUndefined();
  });
});

describe('links to github.com', () => {
  test('a thread links to it by its repository and number', () => {
    const at = (thread: Omit<Parameters<typeof threadAddressOf>[0], 'repository'>) =>
      threadAddressOf({ repository: 'o-1/r.x_y', ...thread });
    expect(at({ kind: 'pull', number: 12 })).toBe('https://github.com/o-1/r.x_y/pull/12');
    expect(at({ kind: 'issue', number: 41 })).toBe('https://github.com/o-1/r.x_y/issues/41');
    expect(at({ kind: 'discussion', number: 7 })).toBe(
      'https://github.com/o-1/r.x_y/discussions/7',
    );
    expect(at({ kind: 'run', number: 168 })).toBe('https://github.com/o-1/r.x_y/actions/runs/168');
    expect(at({ kind: 'run', commit: '4f2a9c1' })).toBe(
      'https://github.com/o-1/r.x_y/commit/4f2a9c1',
    );
    expect(at({ kind: 'run' })).toBe('https://github.com/o-1/r.x_y/actions');
    expect(repositoryAddressOf('o-1/r.x_y')).toBe('https://github.com/o-1/r.x_y');
  });

  test('nothing links that GitHub would not name so', () => {
    expect(threadAddressOf({ repository: 'o/..', kind: 'pull', number: 1 })).toBeUndefined();
    expect(
      threadAddressOf({ repository: 'evil.example/x/y', kind: 'pull', number: 1 }),
    ).toBeUndefined();
    expect(threadAddressOf({ repository: 'o/r', kind: 'pull' })).toBeUndefined();
    expect(threadAddressOf({ repository: 'o/r', kind: 'issue', number: 1.5 })).toBeUndefined();
    expect(threadAddressOf({ repository: 'o/r', kind: 'run', commit: '../../x' })).toBe(
      'https://github.com/o/r/actions',
    );
    expect(repositoryAddressOf('//evil.example')).toBeUndefined();
  });
});
