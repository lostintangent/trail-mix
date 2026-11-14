import { expect, test } from 'bun:test';
import { completed, completionsFor, typingIn } from './completion.ts';

const rae = { name: 'Rae Chen', email: 'rae@example.com' };
const theo = { name: 'Theo Park', email: 'theo@example.org' };

/** A field with the caret where `|` is, and the address the caret is in. */
const typing = (written: string) => {
  const caret = written.indexOf('|');
  const field = written.replace('|', '');
  return { field, typing: typingIn(field, caret) };
};

test('the address being typed is the one the caret is in, between commas or semicolons', () => {
  expect(typing('ra|').typing).toEqual({ start: 0, end: 2, query: 'ra' });
  expect(typing('ada@example.com, ra|').typing.query).toBe('ra');
  expect(typing('ada@example.com; ra|').typing.query).toBe('ra');
  const { field, typing: middle } = typing('ada@example.com, th|eo , bo@example.net');
  expect(middle.query).toBe('theo');
  expect(field.slice(middle.end)).toBe(', bo@example.net');
});

test('a comma within quotes or angle brackets ends no address', () => {
  expect(typing('"Chen, Rae" <rae@example.com>, th|').typing.query).toBe('th');
  expect(typing('Rae <rae,chen@example.com>, th|').typing.query).toBe('th');
  expect(typing('"Chen, \\"R\\"" <rae@example.com>, th|').typing.query).toBe('th');
});

test('an address already in angle brackets completes to nobody', () => {
  expect(typing('Rae Chen <rae@ex|ample.com>').typing.query).toBe('');
  expect(typing('Rae Chen <rae|').typing.query).toBe('');
});

test('a pick takes the place of the address being typed, ready for the next', () => {
  const last = typing('ada@example.com, ra|');
  const next = completed(last.field, last.typing, rae);
  expect(next.field).toBe('ada@example.com, Rae Chen <rae@example.com>, ');
  expect(next.caret).toBe(next.field.length);
  const first = typing('  ra|');
  expect(completed(first.field, first.typing, rae).field).toBe('Rae Chen <rae@example.com>, ');
  // In the middle, what follows stays, and the caret rests after the pick.
  const middle = typing('ada@example.com,th| , bo@example.net');
  const picked = completed(middle.field, middle.typing, theo);
  expect(picked.field).toBe('ada@example.com, Theo Park <theo@example.org>, bo@example.net');
  expect(picked.field.slice(0, picked.caret)).toEndWith('<theo@example.org>');
});

test('a person the field already names elsewhere is not offered again', () => {
  const { field, typing: at } = typing('RAE@example.com, |');
  expect(completionsFor(field, at, [rae, theo])).toEqual([theo]);
  // The address being typed, even when it is a person's whole address, doesn't count.
  const again = typing('rae@example.com|');
  expect(completionsFor(again.field, again.typing, [rae, theo])).toEqual([rae, theo]);
});
