import { expect, test } from 'bun:test';
import { sizeText } from './size.ts';

test('a size counts 1,000 bytes to a kilobyte, as macOS and iOS do', () => {
  expect(sizeText(999)).toBe('999 B');
  expect(sizeText(100_000)).toBe('100 KB');
  expect(sizeText(1_500_000)).toBe('1.5 MB');
});

test('a file just under a megabyte reads as one, never as 1000 KB', () => {
  expect(sizeText(999_600)).toBe('1.0 MB');
});
