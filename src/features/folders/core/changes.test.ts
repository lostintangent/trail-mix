import { expect, test } from 'bun:test';
import type { Folder, View } from '../../mail/core/index.ts';
import { changed, followed, isShown, standing, type FolderChange } from './changes.ts';
import { deleteSaid } from './question.ts';

const folder = (path: string, extra: Partial<Folder> = {}): Folder => {
  const at = path.lastIndexOf('/');
  return {
    account: 'personal',
    path,
    name: path.slice(at + 1),
    ...(at >= 0 ? { parent: path.slice(0, at) } : {}),
    delimiter: '/',
    unread: 0,
    total: 0,
    ...extra,
  };
};
const trips = folder('Trips', { total: 3 });
const japan = folder('Trips/Japan', { total: 1 });
const kyoto = folder('Trips/Japan/Kyoto', { total: 5 });
// Another account's folders, which share paths and change with nothing here.
const workTrips = folder('Trips', { account: 'work' });
const workJapan = folder('Trips/Japan', { account: 'work' });
const folders = [folder('INBOX', { role: 'inbox' }), trips, japan, kyoto, workTrips, workJapan];
const paths = (held: readonly Folder[]) => held.map(({ account, path }) => `${account}:${path}`);

test('a new folder shows at once, once', () => {
  const lisbon = folder('Trips/Lisbon');
  const create: FolderChange = { do: 'create', folder: lisbon };
  expect(changed(folders, create)).toEqual([...folders, lisbon]);
  expect(changed(changed(folders, create), create)).toHaveLength(folders.length + 1);
  expect(isShown(folders, create)).toBe(false);
  expect(isShown([...folders, lisbon], create)).toBe(true);
});

test('a rename takes the folders inside along, in that account only', () => {
  const rename: FolderChange = { do: 'rename', folder: trips, to: 'Travel' };
  const after = changed(folders, rename);
  expect(paths(after)).toEqual([
    'personal:INBOX',
    'personal:Travel',
    'personal:Travel/Japan',
    'personal:Travel/Japan/Kyoto',
    'work:Trips',
    'work:Trips/Japan',
  ]);
  expect(after[1]).toMatchObject({ name: 'Travel', total: 3 });
  expect(after[1]!.parent).toBeUndefined();
  expect(after[3]).toMatchObject({ name: 'Kyoto', parent: 'Travel/Japan', total: 5 });
  expect(isShown(folders, rename)).toBe(false);
  // A listing taken while the server had made the new folder but not yet dropped the old.
  expect(isShown([...folders, folder('Travel')], rename)).toBe(false);
  expect(isShown(after, rename)).toBe(true);
});

test('a folder renamed inside another keeps its parent and takes its new name', () => {
  const after = changed(folders, { do: 'rename', folder: japan, to: 'Trips/Nippon' });
  expect(after.find(({ path }) => path === 'Trips/Nippon')).toMatchObject({
    name: 'Nippon',
    parent: 'Trips',
  });
  expect(after.find(({ path }) => path === 'Trips/Nippon/Kyoto')).toMatchObject({
    parent: 'Trips/Nippon',
  });
});

test('a delete takes the folders inside, in that account only', () => {
  const remove: FolderChange = { do: 'delete', folder: trips };
  const after = changed(folders, remove);
  expect(paths(after)).toEqual(['personal:INBOX', 'work:Trips', 'work:Trips/Japan']);
  expect(isShown(folders, remove)).toBe(false);
  expect(isShown(after, remove)).toBe(true);
});

test('a view in a renamed folder follows it, and one in a deleted folder goes to the Inbox', () => {
  const inKyoto: View = {
    in: 'folder',
    folder: { account: 'personal', path: 'Trips/Japan/Kyoto' },
  };
  const rename: FolderChange = { do: 'rename', folder: trips, to: 'Travel' };
  expect(followed(inKyoto, rename)).toEqual({
    in: 'folder',
    folder: { account: 'personal', path: 'Travel/Japan/Kyoto' },
  });
  expect(followed(inKyoto, { do: 'delete', folder: japan })).toEqual({ in: 'inbox' });
  // Another account's folder of the same path, a folder whose name merely begins with the path,
  // and a unified view all stay.
  const elsewhere: View = { in: 'folder', folder: { account: 'work', path: 'Trips/Japan' } };
  const tripsy: View = { in: 'folder', folder: { account: 'personal', path: 'Tripsy' } };
  for (const view of [elsewhere, tripsy, { in: 'inbox' } as View]) {
    expect(followed(view, rename)).toBe(view);
    expect(followed(view, { do: 'delete', folder: trips })).toBe(view);
  }
});

test('a view of a folder that has gone, or whose account has, gives way to the Inbox', () => {
  const japanView: View = { in: 'folder', folder: { account: 'personal', path: 'Trips/Japan' } };
  expect(standing(japanView, folders)).toBe(japanView);
  expect(
    standing({ in: 'folder', folder: { account: 'personal', path: 'Peru' } }, folders),
  ).toEqual({ in: 'inbox' });
  expect(standing({ in: 'folder', folder: { account: 'gone', path: 'Trips' } }, folders)).toEqual({
    in: 'inbox',
  });
  const flagged: View = { in: 'flagged' };
  expect(standing(flagged, [])).toBe(flagged);
});

test('the question before a delete says what goes with the folder', () => {
  expect(deleteSaid(trips, folders)).toBe(
    'Trips, with 2 folders inside it and 9 messages, will be deleted from the mail server. This can’t be undone.',
  );
  expect(deleteSaid(japan, folders)).toBe(
    'Japan, with 1 folder inside it and 6 messages, will be deleted from the mail server. This can’t be undone.',
  );
  expect(deleteSaid(folder('Notes', { total: 1 }), folders)).toBe(
    'Notes, with 1 message, will be deleted from the mail server. This can’t be undone.',
  );
  expect(deleteSaid(workTrips, folders)).toBe(
    'Trips, with 1 folder inside it, will be deleted from the mail server. This can’t be undone.',
  );
  expect(deleteSaid(folder('Empty'), folders)).toBe(
    'Empty will be deleted from the mail server. This can’t be undone.',
  );
});
