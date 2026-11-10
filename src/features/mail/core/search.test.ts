import { expect, test } from 'bun:test';
import { highlight, marksOf, searchWords } from './search.ts';

const marked = (text: string, search: string) =>
  highlight(text, marksOf(search))
    .filter(({ isMarked }) => isMarked)
    .map(({ text }) => text);

test('marks the start of each word that begins with a word typed', () => {
  expect(marked('Re: Lunch Thursday?', 'lun thu')).toEqual(['Lun', 'Thu']);
  expect(marked('Ada Park', 'ada')).toEqual(['Ada']);
});

test('marks the whole of every word that matches, and nothing else', () => {
  expect(highlight('Lunch at Lune', marksOf('lun'))).toEqual([
    { text: 'Lun', isMarked: true },
    { text: 'ch at ', isMarked: false },
    { text: 'Lun', isMarked: true },
    { text: 'e', isMarked: false },
  ]);
});

test('ignores case and accents in either the text or the search', () => {
  expect(marked('Café on FRIDAY', 'cafe fri')).toEqual(['Café', 'FRI']);
  expect(marked('Cafe on Friday', 'CAFÉ')).toEqual(['Cafe']);
});

test('marks a word only where it starts a word, never inside one', () => {
  expect(marked('Brunch', 'unch')).toEqual([]);
});

test('marks as far as the longest word typed that matches', () => {
  expect(marked('Thursday', 'th thursd')).toEqual(['Thursd']);
});

test('reads anything typed as words, so punctuation marks nothing', () => {
  expect(searchWords('"lunch" OR (thu*)')).toEqual(['lunch', 'OR', 'thu']);
  expect(highlight('Lunch', marksOf('  "* '))).toEqual([{ text: 'Lunch', isMarked: false }]);
});

test('keeps every character of the text, marked or not', () => {
  const text = 'Re: Ünïcode 🎉 naïve — résumé';
  const runs = highlight(text, marksOf('re unicode naive resume'));
  expect(runs.map(({ text }) => text).join('')).toBe(text);
  expect(runs.filter(({ isMarked }) => isMarked).map(({ text }) => text)).toEqual([
    'Re',
    'Ünïcode',
    'naïve',
    'résumé',
  ]);
});
