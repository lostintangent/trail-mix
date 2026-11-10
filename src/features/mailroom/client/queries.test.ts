import { expect, test } from 'bun:test';
import type { Hint, MessageRef, View } from '../../mail/core/index.ts';
import { isStale, keys, type Key } from './queries.ts';

const inbox = { account: 'personal', path: 'INBOX' };
const archive = { account: 'personal', path: 'Archive' };
const workInbox = { account: 'work', path: 'INBOX' };
const ref: MessageRef = { ...inbox, uidValidity: 7, uid: 42 };

const views: View[] = [
  { in: 'folder', folder: inbox },
  { in: 'folder', folder: archive },
  { in: 'folder', folder: workInbox },
  { in: 'inbox' },
  { in: 'flagged' },
  { in: 'drafts' },
  { in: 'search', text: 'lunch' },
];

/** Every snapshot a browser can hold, named for reading in a failure. */
const snapshots: [string, Key][] = [
  ['accounts', keys.accounts],
  ['folders', keys.folders],
  ['outbox', keys.outbox],
  ...views.map((view): [string, Key] => [
    `list of ${view.in === 'folder' ? `${view.folder.account} ${view.folder.path}` : view.in}`,
    keys.conversations(view),
  ]),
  ['open conversation', keys.conversation('c1')],
  ['body', keys.body(ref)],
];

const staleAfter = (hint: Hint) =>
  snapshots.filter(([, key]) => isStale(key, hint)).map(([name]) => name);

// The work Inbox shares the path "INBOX", so only the account tells the two lists apart.
test('a change to a folder’s mail refetches its counts, its list, every view across accounts, the open conversation and the Outbox', () => {
  expect(staleAfter({ changed: 'conversations', folder: inbox })).toEqual([
    'folders',
    'outbox',
    'list of personal INBOX',
    'list of inbox',
    'list of flagged',
    'list of drafts',
    'list of search',
    'open conversation',
  ]);
});

test('accounts, folders and the Outbox each refetch only what shows them', () => {
  expect(staleAfter({ changed: 'accounts' })).toEqual(['accounts']);
  expect(staleAfter({ changed: 'folders', account: 'personal' })).toEqual(['folders']);
  expect(staleAfter({ changed: 'outbox' })).toEqual(['outbox']);
});

test('a body never changes, so no hint refetches one', () => {
  const hints: Hint[] = [
    { changed: 'accounts' },
    { changed: 'folders', account: 'personal' },
    { changed: 'conversations', folder: inbox },
    { changed: 'outbox' },
  ];

  for (const hint of hints) expect(staleAfter(hint)).not.toContain('body');
});
