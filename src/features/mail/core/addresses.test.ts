import { expect, test } from 'bun:test';
import { addressesIn } from './addresses.ts';

test('a name and an angle address, or a bare address, are each one address', () => {
  expect(addressesIn('Ada Lovelace <ada@example.com>')).toEqual([
    { name: 'Ada Lovelace', email: 'ada@example.com' },
  ]);
  expect(addressesIn('ada@example.com')).toEqual([{ email: 'ada@example.com' }]);
  expect(addressesIn('<ada@example.com>')).toEqual([{ email: 'ada@example.com' }]);
});

test('a list is split at commas outside quotes, comments and angle brackets', () => {
  expect(
    addressesIn(
      '"Hopper, Grace" <grace@example.com>, alan@example.org (Turing, Alan), Edsger <"e"@example.net>, <x,y@example.com>',
    ),
  ).toEqual([
    { name: 'Hopper, Grace', email: 'grace@example.com' },
    { name: 'Turing, Alan', email: 'alan@example.org' },
    { name: 'Edsger', email: '"e"@example.net' },
    { email: 'x,y@example.com' },
  ]);
});

test('a group gives its members, and an empty group gives no one', () => {
  expect(
    addressesIn('Engines: ada@example.com, Grace <grace@example.com>;, alan@example.org'),
  ).toEqual([
    { email: 'ada@example.com' },
    { name: 'Grace', email: 'grace@example.com' },
    { email: 'alan@example.org' },
  ]);
  expect(addressesIn('undisclosed-recipients:;')).toEqual([]);
});

test('encoded words are decoded, and two in a row join without the space between them', () => {
  expect(
    addressesIn(
      '=?UTF-8?Q?Caf?= =?UTF-8?Q?=C3=A9_du_Port?= <cafe@example.com>, =?iso-8859-1?B?SvxyZ2Vu?= Klein <jk@example.de>',
    ),
  ).toEqual([
    { name: 'Café du Port', email: 'cafe@example.com' },
    { name: 'Jürgen Klein', email: 'jk@example.de' },
  ]);
  expect(addressesIn('"=?UTF-8?B?8J+agA==?= Launch" <launch@example.com>')).toEqual([
    { name: '🚀 Launch', email: 'launch@example.com' },
  ]);
});

test('an encoded word that cannot be decoded stays as written', () => {
  expect(addressesIn('=?x-unknown?Q?Ada?= <ada@example.com>')).toEqual([
    { name: '=?x-unknown?Q?Ada?=', email: 'ada@example.com' },
  ]);
  expect(addressesIn('=?UTF-8?B?not*base64?= <ada@example.com>')[0]!.email).toBe('ada@example.com');
});

test('a comment may hold comments, and names a bare address', () => {
  expect(addressesIn('ada@example.com (Ada (the Countess) Lovelace), grace@example.com')).toEqual([
    { name: 'Ada (the Countess) Lovelace', email: 'ada@example.com' },
    { email: 'grace@example.com' },
  ]);
});

test('quotes undo their escapes, and a comment beside a name is not part of it', () => {
  expect(addressesIn('"Ada \\"Countess\\" Lovelace" (math) <ada@example.com> (home)')).toEqual([
    { name: 'Ada "Countess" Lovelace', email: 'ada@example.com' },
  ]);
});

test('what mailers break still reads', () => {
  expect(addressesIn('  Ada   Lovelace   < ada@example.com >  ')).toEqual([
    { name: 'Ada Lovelace', email: 'ada@example.com' },
  ]);
  expect(addressesIn('Ada <ada@example.com')).toEqual([{ name: 'Ada', email: 'ada@example.com' }]);
  expect(addressesIn('<@relay.example.com:ada@example.com>')).toEqual([
    { email: 'ada@example.com' },
  ]);
  expect(addressesIn(',, ada@example.com ,')).toEqual([{ email: 'ada@example.com' }]);
});

test('a mailbox with no address gives nothing', () => {
  expect(addressesIn('')).toEqual([]);
  expect(addressesIn('Ada Lovelace')).toEqual([]);
  expect(addressesIn('Ada <>, Grace <grace>, <@example.com>')).toEqual([]);
});
