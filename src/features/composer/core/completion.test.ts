import { expect, test } from 'bun:test';
import {
  addressesOf,
  committed,
  completionsFor,
  editing,
  fieldOf,
  isWritten,
  pasted,
  picked,
  problemIn,
  queryOf,
  removed,
  stillNamed,
  typed,
  type AddressField,
} from './completion.ts';

const rae = { name: 'Rae Chen', email: 'rae@example.com' };
const theo = { name: 'Theo Park', email: 'theo@example.org' };
const empty: AddressField = { chips: [], typing: '' };

test('a comma or semicolon makes what was typed before it a chip, and what follows stays typed', () => {
  expect(typed(empty, 'rae@example.com')).toEqual({ chips: [], typing: 'rae@example.com' });
  expect(typed(empty, 'rae@example.com, th')).toEqual({
    chips: [{ address: { email: 'rae@example.com' } }],
    typing: 'th',
  });
  expect(typed(fieldOf([rae]), 'Theo Park <theo@example.org>;')).toEqual({
    chips: [{ address: rae }, { address: theo }],
    typing: '',
  });
  // A separator alone makes nothing.
  expect(typed(fieldOf([rae]), ', ')).toEqual(fieldOf([rae]));
});

test('a comma within quotes or angle brackets ends no address', () => {
  expect(typed(empty, '"Chen, Rae" <rae@exa')).toEqual({
    chips: [],
    typing: '"Chen, Rae" <rae@exa',
  });
  expect(typed(empty, '"Chen, Rae" <rae@example.com>, ').chips).toEqual([
    { address: { name: 'Chen, Rae', email: 'rae@example.com' } },
  ]);
  expect(typed(empty, '"Chen, \\"R\\"" <rae@example.com>,').chips).toEqual([
    { address: { name: 'Chen, "R"', email: 'rae@example.com' } },
  ]);
});

test('text that names no address becomes a chip that says so, which Send finds', () => {
  const field = typed(fieldOf([rae]), 'rae, theo@example.org,');
  expect(field.chips).toEqual([
    { address: rae },
    { text: 'rae' },
    { address: { email: 'theo@example.org' } },
  ]);
  expect(problemIn(field)).toEqual({ at: 1, text: 'rae' });
  expect(problemIn(removed(field, 1))).toBeUndefined();
  // Send is offered for it, to say so, as it is for an address typed and no chip at all.
  expect(isWritten({ chips: [{ text: 'rae' }], typing: '' })).toBe(true);
  expect(isWritten({ chips: [], typing: 'rae@example.com' })).toBe(true);
  expect(isWritten({ chips: [], typing: ' ' })).toBe(false);
  expect(typed(empty, 'rae@, ').chips).toEqual([{ text: 'rae@' }]);
});

test('a paste of several addresses makes a chip of each, and a paste of one lands as typing', () => {
  const list = 'Rae Chen <rae@example.com>; theo@example.org\nbo@example.net';
  expect(pasted(empty, list)).toEqual({
    chips: [
      { address: rae },
      { address: { email: 'theo@example.org' } },
      { address: { email: 'bo@example.net' } },
    ],
    typing: '',
  });
  // Bare addresses a space parts, as a pasted column may.
  expect(pasted(empty, 'rae@example.com theo@example.org')?.chips).toEqual([
    { address: { email: 'rae@example.com' } },
    { address: { email: 'theo@example.org' } },
  ]);
  // Words with one address are a name and the address.
  expect(pasted(empty, 'Rae Chen rae@example.com')).toBeUndefined();
  expect(pasted(empty, 'rae@example.com')).toBeUndefined();
  expect(pasted(empty, 'rae@example.com,')).toBeUndefined();
});

test('an address the field already holds is not added again', () => {
  const field = fieldOf([rae]);
  expect(typed(field, 'RAE@example.com, ').chips).toEqual([{ address: rae }]);
  expect(pasted(field, 'rae@example.com, theo@example.org, theo@example.org')?.chips).toEqual([
    { address: rae },
    { address: { email: 'theo@example.org' } },
  ]);
  expect(picked(field, rae).chips).toEqual([{ address: rae }]);
});

test('Enter, leaving the field or Send makes what is typed a chip, whatever it is', () => {
  expect(committed({ chips: [], typing: 'Rae Chen <rae@example.com>' })).toEqual(fieldOf([rae]));
  expect(committed({ chips: [], typing: 'Rae' })).toEqual({ chips: [{ text: 'Rae' }], typing: '' });
  expect(committed({ chips: [], typing: '  ' })).toEqual(empty);
});

test('the addresses a save or Send takes include those still being typed', () => {
  expect(
    addressesOf({ chips: [{ address: rae }, { text: 'bo' }], typing: 'theo@example.org' }),
  ).toEqual([rae, { email: 'theo@example.org' }]);
  expect(addressesOf({ chips: [{ address: rae }], typing: 'the' })).toEqual([rae]);
});

test('a chip edited goes back to be typed again, after what was typed becomes a chip', () => {
  const field = { chips: [{ address: rae }, { text: 'theo' }], typing: 'bo@example.net' };
  expect(editing(field, 0)).toEqual({
    chips: [{ text: 'theo' }, { address: { email: 'bo@example.net' } }],
    typing: 'Rae Chen <rae@example.com>',
  });
  expect(editing(field, 1).typing).toBe('theo');
  expect(
    editing({ chips: [{ address: { name: 'Chen, Rae', email: rae.email } }], typing: '' }, 0),
  ).toEqual({
    chips: [],
    typing: '"Chen, Rae" <rae@example.com>',
  });
});

test('what is typed completes to the people the field holds no chip for', () => {
  const field = { chips: [{ address: { email: 'RAE@example.com' } }], typing: ' th ' };
  expect(queryOf(field)).toBe('th');
  expect(completionsFor(field, [rae, theo])).toEqual([theo]);
  // An address in angle brackets is written already, and completes to nobody.
  expect(queryOf({ chips: [], typing: 'Rae Chen <rae' })).toBe('');
});

test('the people found for fewer letters stand only while what is typed still names them', () => {
  const rene = { name: 'René Ortiz', email: 'rortiz@example.net' };
  expect(stillNamed([rae, theo, rene], 'the')).toEqual([theo]);
  expect(stillNamed([rae, theo, rene], 'theo@example.o')).toEqual([theo]);
  expect(stillNamed([rae, theo, rene], 'chen ra')).toEqual([rae]);
  // Accents fold as the index folds them.
  expect(stillNamed([rae, theo, rene], 'rene')).toEqual([rene]);
  // A word that begins none of theirs names nobody, so Enter makes it a chip of its own.
  expect(stillNamed([rae, theo, rene], 'the ridge crew')).toEqual([]);
});
