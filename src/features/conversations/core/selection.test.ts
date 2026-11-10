import { expect, test } from 'bun:test';
import { NOTHING_SELECTED, select } from './selection.ts';

const order = ['a', 'b', 'c', 'd', 'e'];

test('a pick alone selects one, a toggle adds or removes one, and both set the anchor', () => {
  const one = select(NOTHING_SELECTED, 'b', 'only', order);
  const two = select(one, 'd', 'toggle', order);

  expect(one).toEqual({ ids: ['b'], anchor: 'b' });
  expect(two).toEqual({ ids: ['b', 'd'], anchor: 'd' });
  expect(select(two, 'b', 'toggle', order)).toEqual({ ids: ['d'], anchor: 'b' });
});

test('extending selects the range from the anchor, either way, and keeps the anchor', () => {
  const anchored = select(NOTHING_SELECTED, 'c', 'only', order);

  expect(select(anchored, 'e', 'extend', order)).toEqual({ ids: ['c', 'd', 'e'], anchor: 'c' });
  expect(select(anchored, 'a', 'extend', order)).toEqual({ ids: ['a', 'b', 'c'], anchor: 'c' });
});

test('extending with no anchor in the list selects the one picked', () => {
  expect(select({ ids: ['x'], anchor: 'x' }, 'b', 'extend', order)).toEqual({
    ids: ['b'],
    anchor: 'b',
  });
});
