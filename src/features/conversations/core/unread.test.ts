import { expect, test } from 'bun:test';
import type { View } from '../../mail/core/index.ts';
import { changeRows } from './triage.ts';
import { unreadFilter, unreadOnly } from './unread.ts';

const projects: View = { in: 'folder', folder: { account: 'personal', path: 'Projects' } };
const unreadIn = (counts: Partial<Record<View['in'], number>>) => (view: View) => counts[view.in];

test('a folder or the unified Inbox offers the filter while it has unread mail', () => {
  expect(unreadFilter(projects, projects, unreadIn({ folder: 3 }))).toEqual({
    isOn: false,
    turnsTo: { ...projects, unread: true },
  });
  expect(unreadFilter({ in: 'inbox' }, { in: 'inbox' }, unreadIn({ inbox: 1 }))).toEqual({
    isOn: false,
    turnsTo: { in: 'inbox', unread: true },
  });
  expect(unreadFilter(projects, projects, unreadIn({ folder: 0 }))).toBeUndefined();
  expect(unreadFilter({ in: 'inbox' }, { in: 'inbox' }, unreadIn({}))).toBeUndefined();
});

test('the filter stays offered while it is on, with nothing left unread, and turns back to the folder', () => {
  const filtered: View = { ...projects, unread: true };
  expect(unreadFilter(filtered, filtered, unreadIn({ folder: 0 }))).toEqual({
    isOn: true,
    turnsTo: projects,
  });
});

test('Flagged, Drafts and the Outbox never offer the filter', () => {
  for (const view of [{ in: 'flagged' }, { in: 'drafts' }, { in: 'outbox' }] as const) {
    expect(unreadFilter(view, view, () => 5)).toBeUndefined();
  }
});

test('a search offers the filter for the view it began from', () => {
  const search: View = { in: 'search', text: 'invoice' };
  expect(unreadFilter(search, projects, unreadIn({ folder: 2, search: 0 }))).toEqual({
    isOn: false,
    turnsTo: { ...projects, unread: true },
  });
  expect(unreadFilter(search, { in: 'flagged' }, () => 2)).toBeUndefined();
});

test('a list of unread mail shows its unread rows and the one kept open, read or not', () => {
  const row = (id: string, unread: number) => ({ id, unread });
  const rows = [row('a', 2), row('b', 0), undefined, row('c', 0), row('d', 1)];

  expect(unreadOnly(rows, 'b')).toEqual([row('a', 2), row('b', 0), undefined, row('d', 1)]);
  expect(unreadOnly(rows, undefined)).toEqual([row('a', 2), undefined, row('d', 1)]);
  // Marked read under the filter, the open one stays, and the rest go.
  const read = changeRows(rows, new Set(['a', 'd']), { unread: 0 });
  expect(unreadOnly(read, 'a')).toEqual([row('a', 0), undefined]);
});
