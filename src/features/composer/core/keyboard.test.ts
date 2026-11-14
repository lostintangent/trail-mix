import { expect, test } from 'bun:test';
import { visibleBand } from './keyboard.ts';

/** The band an iPhone's sheet keeps when the browser shows this much of the page, from this far down. */
const band = (offsetTop: number, height: number, scale = 1) =>
  visibleBand(844, { offsetTop, height, scale });

test('with no keyboard up, the sheet keeps its place', () => {
  expect(band(0, 844)).toEqual({ top: 0, bottom: 0 });
});

test('a keyboard raises the sheet’s bottom to the keyboard’s top', () => {
  expect(band(0, 508)).toEqual({ top: 0, bottom: 336 });
});

test('when the browser scrolls the page under the keyboard, the sheet follows what is seen', () => {
  expect(band(120, 508)).toEqual({ top: 120, bottom: 216 });
});

test('fractions of a pixel round, and a bounce past either edge never pushes the sheet off', () => {
  expect(band(119.6, 508.2)).toEqual({ top: 120, bottom: 216 });
  expect(band(-30, 844).top).toBe(0);
  expect(band(0, 874).bottom).toBe(0);
});

test('a pinch zoom shrinks what is seen, but leaves the sheet where it is', () => {
  expect(band(200, 422, 2)).toEqual({ top: 0, bottom: 0 });
});
