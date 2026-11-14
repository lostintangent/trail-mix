import { expect, test } from 'bun:test';
import { NOTHING_SELECTED, pickedIn, placeAmong, select } from './selection.ts';

const order = ['a', 'b', 'c', 'd', 'e'];

test('a pick alone selects one, a toggle adds or removes one, and both start a range there', () => {
  const one = select(NOTHING_SELECTED, 'b', 'only', order);
  const two = select(one, 'd', 'toggle', order);

  expect(one).toEqual({ ids: ['b'], anchor: 'b', active: 'b' });
  expect(two).toEqual({ ids: ['b', 'd'], anchor: 'd', active: 'd' });
  expect(select(two, 'b', 'toggle', order)).toEqual({ ids: ['d'], anchor: 'b', active: 'b' });
});

test('extending selects the range from the anchor, either way, keeps the anchor and moves the active end', () => {
  const anchored = select(NOTHING_SELECTED, 'c', 'only', order);

  expect(select(anchored, 'e', 'extend', order)).toEqual({
    ids: ['c', 'd', 'e'],
    anchor: 'c',
    active: 'e',
  });
  expect(select(anchored, 'a', 'extend', order)).toEqual({
    ids: ['a', 'b', 'c'],
    anchor: 'c',
    active: 'a',
  });
});

test('extending with no anchor in the list selects the one picked', () => {
  expect(select({ ids: ['x'], anchor: 'x', active: 'x' }, 'b', 'extend', order)).toEqual({
    ids: ['b'],
    anchor: 'b',
    active: 'b',
  });
});

test('a row sits at its place, and the row after it next, while one leaving counts from where it was', () => {
  const places = new Map([
    ['a', 0],
    ['c', 1],
  ]);
  const vacating = { row: { id: 'b' }, at: 1 };

  expect(placeAmong(places, vacating, 'c')).toEqual({ at: 1, after: 2 });
  // The row that took its place, c, is the one after it.
  expect(placeAmong(places, vacating, 'b')).toEqual({ at: 1, after: 1 });
  expect(placeAmong(places, undefined, 'b')).toEqual({ at: -1, after: 0 });
  expect(placeAmong(places, vacating, undefined)).toEqual({ at: -1, after: 0 });
});

test('a selection picks its rows in the list’s order, skipping any the list hasn’t fetched', () => {
  const rows = [{ id: 'a' }, undefined, { id: 'c' }, { id: 'd' }];
  const places = new Map([
    ['a', 0],
    ['c', 2],
    ['d', 3],
  ]);

  expect(pickedIn(rows, places, ['d', 'far', 'a'], undefined)).toEqual([{ id: 'a' }, { id: 'd' }]);
  expect(pickedIn(undefined, places, ['a'], undefined)).toEqual([]);
});

test('a picked row leaving the list stays picked, last, until the selection moves on', () => {
  const rows = [{ id: 'a' }, { id: 'c' }];
  const places = new Map([
    ['a', 0],
    ['c', 1],
  ]);
  const vacating = { row: { id: 'b' }, at: 1 };

  expect(pickedIn(rows, places, ['b', 'a'], vacating)).toEqual([{ id: 'a' }, { id: 'b' }]);
  expect(pickedIn(rows, places, ['c'], vacating)).toEqual([{ id: 'c' }]);
});
