import { expect, test } from 'bun:test';
import { subtree } from './folders.ts';

const listed = ['INBOX', 'Trips', 'Trips/Japan', 'Trips/Japan/Kyoto', 'Trips/Lisbon', 'Tripsy'].map(
  (path) => ({ path, delimiter: '/' }),
);

test('a folder’s subtree is every folder inside it, however deep, before the folder itself', () => {
  const order = subtree(listed, 'Trips', '/');
  expect(order.toSorted()).toEqual(['Trips', 'Trips/Japan', 'Trips/Japan/Kyoto', 'Trips/Lisbon']);
  // Each folder comes before the folder that holds it.
  for (const [at, path] of order.entries()) {
    expect(order.slice(at + 1).some((later) => later.startsWith(`${path}/`))).toBe(false);
  }
  expect(order.at(-1)).toBe('Trips');
});

test('a folder whose name merely begins another’s doesn’t hold it', () => {
  expect(subtree(listed, 'Trips', '/')).not.toContain('Tripsy');
});

test('a folder the server doesn’t list has no subtree, and where folders can’t nest, it’s alone', () => {
  expect(subtree(listed, 'Gone', '/')).toEqual([]);
  expect(subtree(listed, 'Trips', null)).toEqual(['Trips']);
});
