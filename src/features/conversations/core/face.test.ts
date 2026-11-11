import { expect, test } from 'bun:test';
import { faceOf, peopleOf } from './face.ts';

const selves = new Set(['me@example.com', 'me@work.example.com']);

test('a row shows its newest sender who isn’t the member, by any of their addresses', () => {
  const senders = [
    { email: 'Me@Work.example.com' },
    { email: 'me@example.com' },
    { email: 'ada@example.com' },
    { email: 'bo@example.com' },
  ];
  expect(faceOf(senders, selves)).toEqual({ email: 'ada@example.com' });
});

test('it shows the member when only they wrote, and no one for no senders', () => {
  expect(faceOf([{ email: 'me@example.com' }], selves)).toEqual({ email: 'me@example.com' });
  expect(faceOf([], selves)).toBeUndefined();
});

const ME = { name: 'Sam Rivera', email: 'me@example.com' };
const RAE = { name: 'Rae Chen', email: 'rae@example.com' };
const THEO = { name: 'Theo Lindqvist', email: 'theo@example.com' };

test('a row names its senders, and shows the newest who isn’t the member', () => {
  expect(peopleOf({ senders: [ME, RAE], recipients: [RAE] }, selves)).toEqual({
    names: 'Sam, Rae',
    face: RAE,
  });
  expect(peopleOf({ senders: [RAE], recipients: [ME, THEO] }, selves)).toEqual({
    names: 'Rae Chen',
    face: RAE,
  });
});

test('a row only the member wrote names whom it went to, To and then Cc, and shows the first', () => {
  expect(peopleOf({ senders: [ME], recipients: [RAE] }, selves)).toEqual({
    names: 'To Rae Chen',
    face: RAE,
  });
  expect(
    peopleOf({ senders: [ME, { email: 'Me@Work.example.com' }], recipients: [RAE, THEO] }, selves),
  ).toEqual({ names: 'To Rae, Theo', face: RAE });
  expect(peopleOf({ senders: [ME], recipients: [{ email: 'jo@example.com' }] }, selves)).toEqual({
    names: 'To jo@example.com',
    face: { email: 'jo@example.com' },
  });
});

test('it passes over the member among whom it went to', () => {
  expect(
    peopleOf({ senders: [ME], recipients: [{ email: 'ME@example.com' }, THEO] }, selves),
  ).toEqual({ names: 'To Theo Lindqvist', face: THEO });
});

test('a note the member wrote only to themselves names them as whom it went to', () => {
  expect(
    peopleOf({ senders: [ME], recipients: [{ email: 'Me@Work.example.com' }, ME] }, selves),
  ).toEqual({ names: 'To Me@Work.example.com, Sam', face: { email: 'Me@Work.example.com' } });
  expect(peopleOf({ senders: [ME], recipients: [ME] }, selves)).toEqual({
    names: 'To Sam Rivera',
    face: ME,
  });
});

test('a draft addressed to nobody, or to no address with a domain, names no one', () => {
  for (const recipients of [
    [],
    [{ name: 'undisclosed-recipients', email: '' }],
    [{ email: 'rae' }],
  ]) {
    expect(peopleOf({ senders: [ME], recipients }, selves)).toEqual({ names: undefined, face: ME });
  }
  expect(
    peopleOf(
      { senders: [ME], recipients: [{ email: 'rae@' }, { email: 'theo@example.com' }] },
      selves,
    ),
  ).toEqual({ names: 'To theo@example.com', face: { email: 'theo@example.com' } });
});
