import { expect, test } from 'bun:test';
import { parseSrcset, rewriteSrcset } from './srcset.ts';

test('each candidate is rewritten with its descriptor, and one that resolves nowhere goes', () => {
  const resolve = (url: string) => (url.startsWith('https:') ? `/proxy/${url.slice(8)}` : null);
  expect(rewriteSrcset('https://a.example/1.png 1x, cid:part 2x', resolve)).toBe(
    '/proxy/a.example/1.png 1x',
  );
  expect(rewriteSrcset('cid:part', resolve)).toBeNull();
});

test('a candidate a browser would drop is dropped, as its descriptors say', () => {
  const kept = (srcset: string) => parseSrcset(srcset).map(({ descriptor }) => descriptor);
  expect(kept('a.png 2x 1x, b.png 100w 2x, c.png 50h, d.png 0w, e.png -1x')).toEqual([]);
  expect(kept('a.png, b.png 1.5x, c.png 100w 50h, d.png 3e0x')).toEqual([
    '',
    '1.5x',
    '100w',
    '3e0x',
  ]);
});

test('a parenthesis holds commas and spaces until it closes, so nothing in it is a candidate', () => {
  expect(parseSrcset('a.png 1x (b, https://evil.example/c.png 2x), d.png 2x')).toEqual([
    { url: 'd.png', descriptor: '2x' },
  ]);
  expect(parseSrcset('a.png (https://evil.example/c.png 2x')).toEqual([]);
});

test('no text after a URL can carry a second candidate', () => {
  expect(parseSrcset('a.png 1x https://evil.example/b.png')).toEqual([]);
  expect(parseSrcset('a.png https://evil.example/b.png 2x')).toEqual([]);
});
