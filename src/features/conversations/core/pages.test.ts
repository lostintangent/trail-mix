import { expect, test } from 'bun:test';
import { listOf, pagesCovering, type Fetched } from './pages.ts';

const rows = (...ids: string[]) => ids.map((id) => ({ id }));
const page = (
  at: number,
  total: number,
  ids: string[],
  fetchedAt = 1,
): Fetched<{ id: string }> => ({
  items: rows(...ids),
  at,
  total,
  fetchedAt,
});
const ids = (listed: readonly ({ id: string } | undefined)[] | undefined) =>
  listed?.map((row) => row?.id ?? '_').join(' ');

test('a list is as long as its first page says, with its rows at their places', () => {
  expect(ids(listOf([page(0, 5, ['a', 'b'])]))).toBe('a b _ _ _');
});

test('a page anywhere fills its own places, and the places between pages stay empty', () => {
  const listed = listOf([page(0, 8, ['a', 'b']), page(6, 8, ['g', 'h'])]);

  expect(ids(listed)).toBe('a b _ _ _ _ g h');
});

test('there is no list until a page has arrived', () => {
  expect(listOf([])).toBeUndefined();
  expect(listOf([page(0, 0, [])])).toEqual([]);
});

test('the freshest page says how long the list is, and rows past its end leave', () => {
  const older = page(4, 6, ['e', 'f'], 1);
  const fresher = page(0, 5, ['a', 'b'], 2);

  expect(ids(listOf([older, fresher]))).toBe('a b _ _ e');
  expect(ids(listOf([fresher, page(0, 7, ['x', 'a'], 3)]))).toBe('x a _ _ _ _ _');
});

// New mail moved every row down a place after the later page was fetched, and before the first was.
test('a conversation two pages hold shows once, where the fresher page puts it', () => {
  const older = page(0, 6, ['a', 'b', 'c'], 1);
  const fresher = page(3, 7, ['c', 'd', 'e'], 2);

  expect(ids(listOf([older, fresher]))).toBe('a b _ c d e _');
});

test('a place two pages cover holds what the fresher page holds there', () => {
  const older = page(0, 4, ['a', 'b', 'c', 'd'], 1);
  const fresher = page(2, 4, ['x', 'y'], 2);

  expect(ids(listOf([older, fresher]))).toBe('a b x y');
});

test('the pages a stretch of rows needs are those it reaches into, and none past the list’s end', () => {
  expect(pagesCovering([[0, 20]], 120, 50)).toEqual([0]);
  expect(pagesCovering([[30, 60]], 120, 50)).toEqual([0, 50]);
  expect(pagesCovering([[90, 200]], 120, 50)).toEqual([50, 100]);
  expect(pagesCovering([[-30, 10]], 120, 50)).toEqual([0]);
});

test('each stretch brings its own pages, as a selected row far from the rows in sight does', () => {
  expect(
    pagesCovering(
      [
        [600, 620],
        [3, 3],
      ],
      1000,
      50,
    ),
  ).toEqual([0, 600]);
  // Nothing selected is no stretch at all.
  expect(
    pagesCovering(
      [
        [600, 620],
        [-1, -1],
      ],
      1000,
      50,
    ),
  ).toEqual([600]);
});

test('an empty list still has its first page asked about, to hear when mail arrives', () => {
  expect(pagesCovering([[0, 12]], 0, 50)).toEqual([0]);
});
