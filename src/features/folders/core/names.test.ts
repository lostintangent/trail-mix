import { expect, test } from 'bun:test';
import type { Folder, FolderRole } from '../../mail/core/index.ts';
import { childPath, inside, isOwn, nestingOf, renamedPath } from './names.ts';
import { createProblem, deleteProblem, nameProblem, renameProblem } from './problems.ts';

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
const role = (path: string, role: FolderRole, total = 0) => folder(path, { role, total });

const inbox = role('INBOX', 'inbox', 12);
const archive = role('Archive', 'archive');
const trips = folder('Trips', { total: 3 });
const japan = folder('Trips/Japan', { total: 5 });
const kyoto = folder('Trips/Japan/Kyoto', { total: 2 });
const work = folder('Work');
const workArchive = role('Work/Archive', 'archive');
const folders = [inbox, archive, trips, japan, kyoto, work, workArchive];

test('a folder sits inside the deepest folder whose path and delimiter begin its own', () => {
  expect(nestingOf('Trips/Japan/Osaka', folders)).toEqual({ parent: japan, name: 'Osaka' });
  expect(nestingOf('Trips/Lisbon', folders)).toEqual({ parent: trips, name: 'Lisbon' });
  expect(nestingOf('Receipts', folders)).toEqual({ name: 'Receipts' });
  // "Trips" begins "Tripsy", but without its delimiter it isn't Tripsy's parent.
  expect(nestingOf('Tripsy', folders)).toEqual({ name: 'Tripsy' });
  // A path under a folder that isn't there sits at the top, with the delimiter in its name.
  expect(nestingOf('Gone/Child', folders)).toEqual({ name: 'Gone/Child' });
});

test('a child’s path is its parent’s, the parent’s delimiter, then its name', () => {
  expect(childPath(japan, 'Osaka')).toBe('Trips/Japan/Osaka');
  expect(childPath(undefined, 'Receipts')).toBe('Receipts');
  const dotted = folder('INBOX', { role: 'inbox', delimiter: '.' });
  expect(childPath(dotted, 'Receipts')).toBe('INBOX.Receipts');
  const flat = folder('Notes', { delimiter: undefined });
  expect(() => childPath(flat, 'Inner')).toThrow('That folder can’t hold folders.');
});

test('a rename keeps a folder in its parent', () => {
  expect(renamedPath(japan, 'Nippon')).toBe('Trips/Nippon');
  expect(renamedPath(trips, 'Travel')).toBe('Travel');
  expect(nestingOf(renamedPath(kyoto, 'Nara'), folders)).toEqual({ parent: japan, name: 'Nara' });
});

test('a name needs words, no delimiter, and no space at either end', () => {
  const at = { parent: 'Trips', delimiter: '/', folders };
  expect(nameProblem('', at)).toBe('A folder needs a name.');
  expect(nameProblem('   ', at)).toBe('A folder needs a name.');
  expect(nameProblem(' Lisbon', at)).toBe('A folder’s name can’t start or end with a space.');
  expect(nameProblem('Lisbon ', at)).toBe('A folder’s name can’t start or end with a space.');
  expect(nameProblem('Lisbon/Porto', at)).toBe('A folder’s name can’t hold “/”.');
  expect(nameProblem('Lisbon', at)).toBeUndefined();
});

test('the delimiter checked is the parent’s, or the account’s at the top', () => {
  const dotted = [folder('INBOX', { role: 'inbox', delimiter: '.' })];
  expect(nameProblem('a.b', { folders: dotted })).toBe('A folder’s name can’t hold “.”.');
  expect(nameProblem('a/b', { folders: dotted })).toBeUndefined();
  expect(nameProblem('a/b', { folders })).toBe('A folder’s name can’t hold “/”.');
  // Where folders can't nest, no character divides a path.
  const flat = [folder('INBOX', { role: 'inbox', delimiter: undefined })];
  expect(nameProblem('a/b', { folders: flat })).toBeUndefined();
  expect(nameProblem('a.b', { folders, parent: 'Trips', delimiter: '.' })).toBe(
    'A folder’s name can’t hold “.”.',
  );
});

test('a name can’t be a sibling’s, in any case or Unicode form, but a cousin’s is fine', () => {
  expect(nameProblem('Japan', { parent: 'Trips', folders })).toBe(
    'There’s already a folder called “Japan” here.',
  );
  expect(nameProblem('JAPAN', { parent: 'Trips', folders })).toBe(
    'There’s already a folder called “JAPAN” here.',
  );
  expect(nameProblem('Japan', { folders })).toBeUndefined();
  expect(nameProblem('Trips', { parent: 'Work', folders })).toBeUndefined();
  expect(nameProblem('archive', { folders })).toBe(
    'There’s already a folder called “archive” here.',
  );
  // "Café" with a combining accent is the same name as "Café" written with one character.
  const cafe = folder('Caf\u00e9');
  expect(nameProblem('Cafe\u0301', { folders: [cafe] })).toBe(
    'There’s already a folder called “Cafe\u0301” here.',
  );
});

test('a folder being renamed may change its own name’s case', () => {
  expect(nameProblem('trips', { folders, renaming: trips })).toBeUndefined();
  expect(nameProblem('Work', { folders, renaming: trips })).toBe(
    'There’s already a folder called “Work” here.',
  );
});

test('Inbox is the Inbox’s name at the top, in any case, and free anywhere else', () => {
  for (const name of ['INBOX', 'Inbox', 'inbox'])
    expect(nameProblem(name, { folders: [] })).toBe('“Inbox” is the Inbox’s own name.');
  expect(nameProblem('Inbox', { parent: 'Trips', folders })).toBeUndefined();
});

test('only a folder with no role in it or anywhere inside it is the member’s own', () => {
  expect(isOwn(trips, folders)).toBe(true);
  expect(isOwn(kyoto, folders)).toBe(true);
  expect(isOwn(archive, folders)).toBe(false);
  expect(isOwn(inbox, folders)).toBe(false);
  // Renaming Work would carry its Archive along.
  expect(isOwn(work, folders)).toBe(false);
  // INBOX is the Inbox whether or not the server marked its role.
  expect(isOwn(folder('INBOX'), [])).toBe(false);
});

test('a delete takes every folder inside, however deep', () => {
  expect(inside(trips, folders)).toEqual([japan, kyoto]);
  expect(inside(kyoto, folders)).toEqual([]);
  // "Trips" begins "Tripsy", which isn't inside it.
  expect(inside(trips, [...folders, folder('Tripsy')])).toEqual([japan, kyoto]);
});

test('a new folder’s path names a held parent and a name that fits there', () => {
  expect(createProblem('Trips/Lisbon', folders)).toBeUndefined();
  expect(createProblem('Trips/Japan/Osaka', folders)).toBeUndefined();
  expect(createProblem('Receipts', folders)).toBeUndefined();
  expect(createProblem('Trips/Japan', folders)).toBe(
    'There’s already a folder called “Japan” here.',
  );
  // A parent that isn't one of the account's folders leaves its delimiter in the name.
  expect(createProblem('Gone/Child', folders)).toBe('A folder’s name can’t hold “/”.');
  expect(createProblem('inbox', folders)).toBe('“Inbox” is the Inbox’s own name.');
  expect(createProblem('Trips/', folders)).toBe('A folder needs a name.');
});

test('a rename keeps a folder in its parent, under a name that fits there', () => {
  expect(renameProblem(japan, 'Trips/Nippon', folders)).toBeUndefined();
  expect(renameProblem(trips, 'Travel', folders)).toBeUndefined();
  expect(renameProblem(trips, 'TRIPS', folders)).toBeUndefined();
  expect(renameProblem(japan, 'Nippon', folders)).toBe('A rename keeps a folder where it is.');
  expect(renameProblem(japan, 'Work/Japan', folders)).toBe('A rename keeps a folder where it is.');
  expect(renameProblem(trips, 'Trips/Japan', folders)).toBe('A folder’s name can’t hold “/”.');
  expect(renameProblem(japan, 'Trips/japan ', folders)).toBe(
    'A folder’s name can’t start or end with a space.',
  );
  expect(renameProblem(trips, 'Work', folders)).toBe(
    'There’s already a folder called “Work” here.',
  );
  // A folder whose parent the server doesn't list is still renamed within it.
  const orphan = folder('Hidden/Notes');
  expect(renameProblem(orphan, 'Hidden/Jottings', [orphan])).toBeUndefined();
  expect(renameProblem(orphan, 'Jottings', [orphan])).toBe('A rename keeps a folder where it is.');
});

test('a folder with a role, or one inside it, keeps its name and stays', () => {
  const own = 'The account’s own folders, such as Inbox and Archive, stay as they are.';
  const holds =
    'A folder that holds one of the account’s own folders, such as Archive, stays as it is.';
  expect(renameProblem(archive, 'Old', folders)).toBe(own);
  expect(renameProblem(work, 'Job', folders)).toBe(holds);
  expect(deleteProblem(inbox, folders)).toBe(own);
  expect(deleteProblem(work, folders)).toBe(holds);
  expect(deleteProblem(trips, folders)).toBeUndefined();
});
