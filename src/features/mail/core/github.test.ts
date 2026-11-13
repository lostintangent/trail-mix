import { describe, expect, test } from 'bun:test';
import { partsOf } from './conversations.ts';
import {
  BUNDLE_CHIPS,
  bundleIdOf,
  bundlePartsOf,
  bundleSummaryOf,
  repositoryAddressOf,
  threadAddressOf,
  threadOf,
} from './github.ts';
import type { ConversationSummary, Envelope, GitHubThread } from './model.ts';
import { envelope } from './testFixtures.ts';

/** A verified notification of `owner/repo`'s pull request 12, as GitHub sends one. */
function notification(init: Partial<Envelope> = {}, repository = 'trailmix-demo/toy-box') {
  const [owner, repo] = repository.split('/') as [string, string];
  return envelope(`n${Math.random()}`, {
    messageId: `<${repository}/pull/12/c345@github.com>`,
    references: [`<${repository}/pull/12@github.com>`],
    from: { name: 'Luca Bianchi', email: 'notifications@github.com' },
    to: [{ name: repository, email: `${repo}@noreply.github.com` }],
    cc: [{ email: 'me@trailmix.test' }, { name: 'Comment', email: 'comment@noreply.github.com' }],
    subject: `Re: [${repository}] Replayable stream cursors (PR #12)`,
    list: { id: `${repo}.${owner}.github.com` },
    verified: true,
    ...init,
  });
}

const reason = (name: string) => [{ name, email: `${name}@noreply.github.com` }];

describe('a notification reads as its thread', () => {
  test('a pull request names its repository, number and title, and why it came', () => {
    expect(threadOf([notification()])).toEqual({
      repository: 'trailmix-demo/toy-box',
      kind: 'pull',
      number: 12,
      title: 'Replayable stream cursors',
      reasons: ['comment'],
    });
  });

  test('the first message of a thread, which references nothing, names it by its own Message-ID', () => {
    const opened = notification({
      messageId: '<trailmix-demo/toy-box/pull/12@github.com>',
      references: [],
      subject: '[trailmix-demo/toy-box] Replayable stream cursors (PR #12)',
    });
    expect(threadOf([opened])).toMatchObject({
      kind: 'pull',
      number: 12,
      title: 'Replayable stream cursors',
    });
  });

  test('an issue, its events and a discussion', () => {
    const issue = notification(
      {
        messageId: '<o/r/issue/41/issue_event/15320900190@github.com>',
        references: ['<o/r/issues/41@github.com>'],
        subject: 'Re: [o/r] Pane widths reset after a reload (Issue #41)',
      },
      'o/r',
    );
    const discussion = notification(
      {
        messageId: '<o/r/discussions/7/comments/9@github.com>',
        references: ['<o/r/discussions/7@github.com>'],
        subject: 'Re: [o/r] Ideas for the reader (Discussion #7)',
      },
      'o/r',
    );
    expect(threadOf([issue])).toMatchObject({
      kind: 'issue',
      number: 41,
      title: 'Pane widths reset after a reload',
    });
    expect(threadOf([discussion])).toMatchObject({
      kind: 'discussion',
      number: 7,
      title: 'Ideas for the reader',
    });
  });

  test('a run its mail names by check suite says its workflow, outcome and commit', () => {
    const run = (subject: string) =>
      threadOf([
        notification(
          {
            messageId: '<o/r/check-suites/CS_kwDOPUk_Ls8AAAAKCBRHeA/1754560414@github.com>',
            references: [],
            subject,
            cc: reason('ci_activity'),
          },
          'o/r',
        ),
      ]);
    expect(run('[o/r] Run failed: CI - main (4F2A9C1)')).toEqual({
      repository: 'o/r',
      kind: 'run',
      commit: '4f2a9c1',
      title: 'CI - main',
      outcome: 'failed',
      reasons: ['ci_activity'],
    });
    expect(run('[o/r] Run cancelled: Publish Python Package - main (21a187c)')).toMatchObject({
      title: 'Publish Python Package - main',
      outcome: 'cancelled',
    });
    expect(run('[o/r] Run succeeded: CI - main (21a187c)')).toMatchObject({ outcome: 'passed' });
    expect(run('[o/r] Nightly - main')).toEqual({
      repository: 'o/r',
      kind: 'run',
      title: 'Nightly - main',
      reasons: ['ci_activity'],
    });
  });

  test('a run its mail names by id carries the id as its number', () => {
    const run = notification(
      {
        messageId: '<o/r/actions/runs/16801158466@github.com>',
        references: [],
        subject: '[o/r] Run failed: CI - main (88bdcf8)',
      },
      'o/r',
    );
    expect(threadOf([run])).toMatchObject({ kind: 'run', number: 16801158466, commit: '88bdcf8' });
  });

  test('checks on a pull request say how they ended', () => {
    const checks = (preview: string) =>
      threadOf([notification({ preview, cc: reason('ci_activity') })]);
    expect(checks('All checks have passed on #12. 3 successful checks')).toMatchObject({
      outcome: 'passed',
    });
    expect(checks('Some checks were not successful. 1 failing')).toMatchObject({
      outcome: 'failed',
    });
    expect(checks('Pushed 1 commit.')).not.toHaveProperty('outcome');
  });

  test('without a reason Cc, a thread shows its kind and no reason', () => {
    const plain = notification({ cc: [{ email: 'me@trailmix.test' }] });
    expect(threadOf([plain])).toMatchObject({ kind: 'pull', number: 12, reasons: [] });
  });

  test('a Cc that names no reason GitHub gives is no reason', () => {
    const odd = notification({ cc: reason('lunch') });
    expect(threadOf([odd])).toMatchObject({ reasons: [] });
  });

  test('a subject reads plainly, whatever its replies and case', () => {
    const titled = (subject: string) => threadOf([notification({ subject })])?.title;
    expect(titled('RE: Fwd: [TrailMix-Demo/Toy-Box] Cache opened bodies (#12)')).toBe(
      'Cache opened bodies',
    );
    expect(titled('[trailmix-demo/toy-box] Cache (opened) bodies')).toBe('Cache (opened) bodies');
    // A title that is only its number still says something.
    expect(titled('[trailmix-demo/toy-box] (PR #12)')).toBe('(PR #12)');
  });
});

describe("a conversation's messages make one thread", () => {
  const review = notification({
    date: '2026-11-13T09:12:00.000Z',
    subject: '[trailmix-demo/toy-box] Replayable stream encoding (PR #12)',
    cc: reason('review_requested'),
  });
  const comment = notification({ date: '2026-11-13T09:41:00.000Z', cc: reason('comment') });
  const author = notification({ date: '2026-11-13T09:50:00.000Z', cc: reason('author') });

  test('its title is the newest message’s, and its reasons ask first, then go newest first', () => {
    expect(threadOf([review, comment, author])).toMatchObject({
      title: 'Replayable stream cursors',
      reasons: ['review_requested', 'author', 'comment'],
    });
  });

  test('its state is what the newest event said', () => {
    const event = (date: string, preview: string) =>
      notification({
        date,
        preview,
        messageId: `<trailmix-demo/toy-box/pull/12/issue_event/${date}@github.com>`,
      });
    const closed = event('2026-11-13T10:00:00.000Z', 'Closed #12.');
    const reopened = event('2026-11-13T11:00:00.000Z', 'Reopened #12.');
    const merged = event('2026-11-13T12:00:00.000Z', 'Merged #12 into main.');
    expect(threadOf([review, closed])).toMatchObject({ state: 'closed' });
    expect(threadOf([review, closed, reopened])).not.toHaveProperty('state');
    expect(threadOf([merged, review, closed, reopened])).toMatchObject({ state: 'merged' });
    // An event of another number is someone quoting it.
    expect(threadOf([event('2026-11-13T10:00:00.000Z', 'Closed #120.')])).not.toHaveProperty(
      'state',
    );
  });

  test('messages of two threads make none', () => {
    const other = notification({ references: ['<trailmix-demo/toy-box/pull/13@github.com>'] });
    const elsewhere = notification({}, 'trailmix-demo/pixels');
    expect(threadOf([review, other])).toBeUndefined();
    expect(threadOf([review, elsewhere])).toBeUndefined();
  });

  test('one message that is not a notification makes none', () => {
    expect(threadOf([review, comment, notification({ verified: false })])).toBeUndefined();
    expect(threadOf([review, envelope('a reply of my own')])).toBeUndefined();
  });

  test('an empty Inbox makes none', () => {
    expect(threadOf([])).toBeUndefined();
  });
});

describe('mail that is not a verified notification reads as no thread', () => {
  const cases: [string, Partial<Envelope>, string?][] = [
    ['unverified', { verified: false }],
    ['from anyone else at GitHub', { from: { email: 'noreply@github.com' } }],
    ['from a look-alike', { from: { email: 'notifications@github.com.evil.example' } }],
    ['with no List-Id', { list: undefined }],
    ['with another repository’s List-Id', { list: { id: 'pixels.trailmix-demo.github.com' } }],
    ['with a List-Id elsewhere', { list: { id: 'toy-box.trailmix-demo.github.com.evil.example' } }],
    [
      'rooted at another host',
      { references: ['<trailmix-demo/toy-box/pull/12@github.com.evil.example>'] },
    ],
    ['rooted at no repository', { references: ['<pull/12@github.com>'] }],
    ['rooted at a release', { references: ['<trailmix-demo/toy-box/releases/9@github.com>'] }],
    ['rooted at a commit', { references: ['<trailmix-demo/toy-box/commit/4f2a9c1@github.com>'] }],
    ['numbered with no number', { references: ['<trailmix-demo/toy-box/pull/twelve@github.com>'] }],
    ['numbered from zero', { references: ['<trailmix-demo/toy-box/pull/012@github.com>'] }],
    ['with no Message-ID at all', { messageId: '', references: [] }],
  ];
  for (const [name, init] of cases) {
    test(name, () => expect(threadOf([notification(init)])).toBeUndefined());
  }

  const repositories = [
    '-dash/repo',
    'owner/..',
    'owner/.',
    'own er/repo',
    'own%2fer/repo',
    `${'o'.repeat(40)}/repo`,
    `owner/${'r'.repeat(101)}`,
    'owner/re"po',
  ];
  for (const repository of repositories) {
    test(`named ${repository}, which GitHub would not allow`, () => {
      const [owner, repo] = repository.split('/') as [string, string];
      const spoof = notification({
        references: [`<${repository}/pull/12@github.com>`],
        list: { id: `${repo}.${owner}.github.com` },
      });
      expect(threadOf([spoof])).toBeUndefined();
    });
  }
});

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
