import { expect, test } from 'bun:test';
import { linkOf } from './links.ts';

test('a web address links as it is, and one typed without its scheme gains https', () => {
  expect(linkOf('https://example.com/plan')).toBe('https://example.com/plan');
  expect(linkOf('  http://example.org  ')).toBe('http://example.org');
  expect(linkOf('example.com/plan?week=2')).toBe('https://example.com/plan?week=2');
  expect(linkOf('example.org:8080/x')).toBe('https://example.org:8080/x');
});

test('a mail address links as mailto', () => {
  expect(linkOf('ada@example.com')).toBe('mailto:ada@example.com');
  expect(linkOf('mailto:ada@example.com')).toBe('mailto:ada@example.com');
});

test('nothing else makes a link', () => {
  for (const typed of [
    '',
    '   ',
    'two words',
    'javascript:alert(1)',
    'data:text/html,<b>x</b>',
    'mailto:nobody',
    'https://localhost',
    'notalink',
  ]) {
    expect({ typed, link: linkOf(typed) }).toEqual({ typed, link: undefined });
  }
});
