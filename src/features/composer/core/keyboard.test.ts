import { expect, test } from 'bun:test';
import { visibleBand } from './keyboard.ts';

const IPHONE = 844;

test('with no keyboard up, the sheet keeps its place', () => {
  expect(visibleBand(IPHONE, { offsetTop: 0, height: IPHONE, scale: 1 })).toEqual({
    top: 0,
    bottom: 0,
  });
});

test('a keyboard raises the sheet’s bottom to the keyboard’s top', () => {
  expect(visibleBand(IPHONE, { offsetTop: 0, height: 508, scale: 1 })).toEqual({
    top: 0,
    bottom: 336,
  });
});

test('when the browser scrolls the page under the keyboard, the sheet follows what is seen', () => {
  expect(visibleBand(IPHONE, { offsetTop: 120, height: 508, scale: 1 })).toEqual({
    top: 120,
    bottom: 216,
  });
});

test('fractions of a pixel round, and a bounce past either edge never pushes the sheet off', () => {
  expect(visibleBand(IPHONE, { offsetTop: 119.6, height: 508.2, scale: 1 })).toEqual({
    top: 120,
    bottom: 216,
  });
  expect(visibleBand(IPHONE, { offsetTop: -30, height: IPHONE, scale: 1 }).top).toBe(0);
  expect(visibleBand(IPHONE, { offsetTop: 0, height: IPHONE + 30, scale: 1 }).bottom).toBe(0);
});

test('a pinch zoom shrinks what is seen, but leaves the sheet where it is', () => {
  expect(visibleBand(IPHONE, { offsetTop: 200, height: 422, scale: 2 })).toEqual({
    top: 0,
    bottom: 0,
  });
});
