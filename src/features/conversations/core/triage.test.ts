import { expect, test } from 'bun:test';
import type { Folder, FolderRole, Message, View } from '../../mail/core/index.ts';
import {
  changeMessages,
  changeRows,
  commandFor,
  followMoves,
  isShown,
  overlaid,
  putBack,
  rowChange,
  undoOf,
  type Command,
} from './triage.ts';

const ROLES: Partial<Record<string, FolderRole>> = {
  INBOX: 'inbox',
  Archive: 'archive',
  Sent: 'sent',
  Drafts: 'drafts',
  Trash: 'trash',
};

const folders: Folder[] = [
  ...(['INBOX', 'Archive', 'Sent', 'Drafts', 'Trash', 'Projects'] as const).map((path) => ({
    account: 'personal',
    path,
    name: path,
    ...(ROLES[path] && { role: ROLES[path] }),
    unread: 0,
    total: 0,
  })),
  { account: 'work', path: 'Inbox', name: 'Inbox', role: 'inbox', unread: 0, total: 0 },
  { account: 'work', path: 'Archive', name: 'Archive', role: 'archive', unread: 0, total: 0 },
];

let uid = 0;
/** A message of conversation `c1`, read and unflagged unless said otherwise. */
function message(
  path: string,
  extra: Partial<Message> & { seen?: boolean; flagged?: boolean } = {},
) {
  const { seen = true, flagged = false, ...rest } = extra;
  return {
    account: 'personal',
    path,
    uidValidity: 1,
    uid: ++uid,
    messageId: `<m${uid}@example.com>`,
    references: [],
    from: { email: 'ada@example.com' },
    to: [],
    cc: [],
    subject: 'Lunch',
    date: `2026-11-0${uid % 9}T12:00:00Z`,
    preview: '',
    flags: { seen, flagged, answered: false, draft: false },
    hasAttachments: false,
    conversation: 'c1',
    ...rest,
  } satisfies Message;
}

const inbox: View = { in: 'inbox' };
const paths = (command: Command | undefined) =>
  command && 'move' in command ? command.move.map(({ path }) => path) : [];

test('archiving from a unified view moves the conversation’s Inbox messages, and nothing it sent', () => {
  const conversation = [message('INBOX'), message('Sent'), message('INBOX'), message('Archive')];

  const command = commandFor({ do: 'archive' }, inbox, [conversation], folders);

  expect(command).toMatchObject({ to: 'archive' });
  expect(paths(command)).toEqual(['INBOX', 'INBOX']);
});

test('in a folder, an action moves that folder’s messages only', () => {
  const conversation = [message('Projects'), message('INBOX'), message('Projects')];
  const projects: View = { in: 'folder', folder: { account: 'personal', path: 'Projects' } };

  expect(paths(commandFor({ do: 'delete' }, projects, [conversation], folders))).toEqual([
    'Projects',
    'Projects',
  ]);
});

test('a search finds mail anywhere, so a conversation found only in Archive can be deleted and moved', () => {
  const conversation = [message('Archive'), message('Sent'), message('Drafts')];
  const search: View = { in: 'search', text: 'lunch' };
  const projects = { account: 'personal', path: 'Projects' };

  expect(commandFor({ do: 'delete' }, search, [conversation], folders)).toMatchObject({
    to: 'trash',
  });
  expect(paths(commandFor({ do: 'delete' }, search, [conversation], folders))).toEqual(['Archive']);
  expect(paths(commandFor({ do: 'move', to: projects }, search, [conversation], folders))).toEqual([
    'Archive',
  ]);
  expect(commandFor({ do: 'archive' }, search, [conversation], folders)).toBeUndefined();
});

test('Drafts deletes the drafts, not the conversation they answer', () => {
  const conversation = [message('INBOX'), message('Drafts', { seen: true })];

  expect(paths(commandFor({ do: 'delete' }, { in: 'drafts' }, [conversation], folders))).toEqual([
    'Drafts',
  ]);
});

test('a move to a folder takes only that folder’s account, since mail can’t cross accounts', () => {
  const personal = [message('INBOX')];
  const work = [message('Inbox', { account: 'work' })];
  const projects = { account: 'personal', path: 'Projects' };

  const command = commandFor({ do: 'move', to: projects }, inbox, [personal, work], folders);

  expect(command && 'move' in command && command.move.map(({ account }) => account)).toEqual([
    'personal',
  ]);
});

test('flags and read marks change only the messages that aren’t already as asked', () => {
  const conversation = [
    message('INBOX', { seen: false, date: '2026-11-01T09:00:00Z' }),
    message('INBOX', { seen: true, flagged: true, date: '2026-11-02T09:00:00Z' }),
    message('INBOX', { seen: false, date: '2026-11-03T09:00:00Z' }),
  ];
  const uids = (command: Command | undefined) =>
    command && 'setFlags' in command ? command.setFlags.map(({ uid }) => uid) : [];
  const [first, second, newest] = conversation.map(({ uid }) => uid) as [number, number, number];

  expect(uids(commandFor({ do: 'read' }, inbox, [conversation], folders))).toEqual([first, newest]);
  expect(uids(commandFor({ do: 'unflag' }, inbox, [conversation], folders))).toEqual([second]);
  expect(uids(commandFor({ do: 'flag' }, inbox, [conversation], folders))).toEqual([newest]);
  expect(commandFor({ do: 'unread' }, inbox, [conversation], folders)).toBeUndefined();
});

test('an action that would change nothing sends nothing', () => {
  const read = [message('INBOX'), message('Archive')];

  expect(commandFor({ do: 'read' }, inbox, [read], folders)).toBeUndefined();
  expect(commandFor({ do: 'archive' }, inbox, [[message('Archive')]], folders)).toBeUndefined();
});

test('Undo puts each moved message back in the folder it left', () => {
  const ref = (path: string, uid: number) => ({ account: 'personal', path, uidValidity: 1, uid });
  const command: Command = {
    move: [ref('INBOX', 1), ref('Projects', 2), ref('INBOX', 3)],
    to: 'trash',
  };
  const moved = [
    { from: ref('INBOX', 1), to: ref('Trash', 41) },
    { from: ref('Projects', 2), to: ref('Trash', 42) },
    { from: ref('INBOX', 3), to: ref('Trash', 43) },
  ];

  expect(undoOf(command, moved)).toEqual([
    { move: [ref('Trash', 41), ref('Trash', 43)], to: { account: 'personal', path: 'INBOX' } },
    { move: [ref('Trash', 42)], to: { account: 'personal', path: 'Projects' } },
  ]);
});

test('a moved message is known by the ref the move gave it, and the rest keep theirs', () => {
  const [kept, moving, sent] = [message('INBOX'), message('INBOX'), message('Sent')];
  const elsewhere = message('INBOX', { conversation: 'c2' });
  const to = { account: 'personal', path: 'Archive', uidValidity: 7, uid: 900 };

  const followed = followMoves(
    [kept, moving, sent],
    [
      { from: moving, to },
      { from: elsewhere, to: { ...to, uid: 901 } },
    ],
  );

  expect(followed).toEqual([kept, { ...moving, ...to }, sent]);
  expect(followMoves([kept, sent], [{ from: moving, to }])).toBeUndefined();
});

test('Undo of a read mark makes unread again only the messages it marked', () => {
  const conversation = [
    message('INBOX', { seen: false }),
    message('INBOX'),
    message('INBOX', { seen: false }),
  ];
  const command = commandFor({ do: 'read' }, inbox, [conversation], folders)!;

  expect(undoOf(command)).toEqual([
    { setFlags: 'setFlags' in command ? command.setFlags : [], change: { seen: false } },
  ]);
  expect(changeMessages(conversation, command).map(({ flags }) => flags.seen)).toEqual([
    true,
    true,
    true,
  ]);
});

test('a moved conversation leaves its list, except Flagged and a search, which still hold it', () => {
  const views: [View, unknown][] = [
    [inbox, 'gone'],
    [{ in: 'folder', folder: { account: 'personal', path: 'Projects' } }, 'gone'],
    [{ in: 'flagged' }, undefined],
    [{ in: 'search', text: 'lunch' }, undefined],
  ];

  for (const [view, change] of views)
    expect(rowChange({ do: 'archive' }, view)).toBe(change as never);
  expect(rowChange({ do: 'unflag' }, { in: 'flagged' })).toBe('gone');
  expect(rowChange({ do: 'unflag' }, inbox)).toEqual({ flagged: false });
});

test('a row change reaches the triaged conversations and no others', () => {
  const rows = [
    { id: 'a', unread: 2, flagged: false },
    { id: 'b', unread: 1, flagged: false },
    { id: 'c', unread: 0, flagged: true },
  ];

  expect(changeRows(rows, new Set(['a', 'c']), 'gone').map(({ id }) => id)).toEqual(['b']);
  expect(changeRows(rows, new Set(['a']), { unread: 0 })).toEqual([
    { id: 'a', unread: 0, flagged: false },
    { id: 'b', unread: 1, flagged: false },
    { id: 'c', unread: 0, flagged: true },
  ]);
});

test('putting rows back returns each to its place by date, and restores what changed in place', () => {
  const row = (id: string, date: string, unread = 0) => ({ id, date, unread });
  const now = [row('a', '2026-11-09'), row('d', '2026-11-03', 0)];
  const earlier = [row('b', '2026-11-07'), row('c', '2026-11-05'), row('d', '2026-11-03', 2)];

  expect(putBack(now, earlier)).toEqual([
    row('a', '2026-11-09'),
    row('b', '2026-11-07'),
    row('c', '2026-11-05'),
    row('d', '2026-11-03', 2),
  ]);
});

test('a row put back beside one of the same date takes the place the Mailroom gives it, by id', () => {
  const row = (id: string) => ({ id, date: '2026-11-09T06:04:00Z' });

  expect(putBack([row('c'), row('a')], [row('b')])).toEqual([row('c'), row('b'), row('a')]);
  expect(putBack([row('b')], [row('c'), row('a')])).toEqual([row('c'), row('b'), row('a')]);
});

test('overlays lay over a snapshot in order, so an Undo after an archive shows the row again', () => {
  const row = (id: string, date: string) => ({ id, date, unread: 1, flagged: false });
  const rows = [row('a', '2026-11-09'), row('b', '2026-11-08')];
  const archived = { ids: new Set(['a']), change: 'gone' as const };
  const read = { ids: new Set(['b']), change: { unread: 0 } };

  expect(overlaid(rows, [archived, read])).toEqual([{ ...row('b', '2026-11-08'), unread: 0 }]);
  expect(overlaid(rows, [archived, { returning: [row('a', '2026-11-09')] }])).toEqual(rows);
});

test('a snapshot shows an overlay once its rows are gone, or changed, or back as they were', () => {
  const row = (id: string, unread = 0, flagged = false) => ({
    id,
    date: '2026-11-09',
    unread,
    flagged,
  });
  const gone = { ids: new Set(['a']), change: 'gone' as const };
  const flagged = { ids: new Set(['a']), change: { flagged: true } };
  const back = { returning: [row('a', 2)] };

  expect(isShown([row('a'), row('b')], gone)).toBe(false);
  expect(isShown([row('b')], gone)).toBe(true);
  expect(isShown([row('a')], flagged)).toBe(false);
  expect(isShown([row('a', 0, true)], flagged)).toBe(true);
  expect(isShown([row('b')], back)).toBe(false);
  expect(isShown([row('a', 0)], back)).toBe(false);
  expect(isShown([row('a', 2)], back)).toBe(true);
});
