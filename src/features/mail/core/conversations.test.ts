import { expect, test } from 'bun:test';
import { messageIdOf, referencesOf } from './conversations.ts';
import { arrive, envelope, fold, threads } from './testFixtures.ts';

// Linking

test('a reply joins the conversation of the message it answers', () => {
  const index = fold(
    arrive(
      envelope('question'),
      envelope('answer', { references: ['<question@example.com>'] }),
      envelope('unrelated'),
    ),
  );

  expect(threads(index)).toEqual([['answer', 'question'], ['unrelated']]);
});

test('a reply that arrives before the message it answers still joins it', () => {
  const index = fold(
    arrive(envelope('answer', { references: ['<question@example.com>'] }), envelope('question')),
  );

  expect(threads(index)).toEqual([['answer', 'question']]);
});

test('replies to a message the index never held share a conversation through it', () => {
  const index = fold(
    arrive(
      envelope('first reply', { references: ['<missing@example.com>'] }),
      envelope('second reply', { references: ['<missing@example.com>'] }),
    ),
  );

  expect(threads(index)).toEqual([['first reply', 'second reply']]);
});

test('a message that answers two conversations merges them', () => {
  const index = fold(
    arrive(
      envelope('lunch'),
      envelope('dinner'),
      envelope('both', { references: ['<lunch@example.com>', '<dinner@example.com>'] }),
    ),
  );

  expect(threads(index)).toEqual([['both', 'dinner', 'lunch']]);
});

test('Inbox, Sent, Archive and Drafts gather into one conversation, and other folders keep to themselves', () => {
  const answering = (subject: string, path: string) =>
    envelope(subject, { path, references: ['<question@example.com>'] });

  const index = fold(
    arrive(
      envelope('question'),
      answering('sent', 'Sent'),
      answering('archived', 'Archive'),
      answering('draft', 'Drafts'),
      answering('trashed', 'Trash'),
      answering('trashed too', 'Trash'),
      answering('junk', 'Junk'),
      answering('filed', 'Projects'),
    ),
  );

  expect(threads(index)).toEqual([
    ['archived', 'draft', 'question', 'sent'],
    ['filed'],
    ['junk'],
    ['trashed', 'trashed too'],
  ]);
});

test('the same message in two folders, or two accounts, is one conversation per account', () => {
  const index = fold(
    arrive(
      envelope('in inbox', { messageId: '<shared@example.com>' }),
      envelope('in archive', { path: 'Archive', messageId: '<shared@example.com>' }),
      envelope('in work', { account: 'work', messageId: '<shared@example.com>' }),
    ),
  );

  expect(threads(index)).toEqual([['in archive', 'in inbox'], ['in work']]);
});

test('messages are never joined by subject, or by both lacking a Message-ID', () => {
  const index = fold(
    arrive(
      envelope('Lunch?', { messageId: '<one@example.com>' }),
      envelope('Lunch?', { messageId: '<two@example.com>' }),
      envelope('no id', { messageId: '' }),
      envelope('no id either', { messageId: '' }),
    ),
  );

  expect(threads(index)).toEqual([['Lunch?'], ['Lunch?'], ['no id'], ['no id either']]);
});

// Reading the headers that link them

test('References name the thread from its first message, and In-Reply-To adds the parent it leaves out', () => {
  expect(referencesOf('<a@x> <b@x>', '<c@x>')).toEqual(['<a@x>', '<b@x>', '<c@x>']);
  expect(referencesOf('<a@x> <b@x>', '<b@x>')).toEqual(['<a@x>', '<b@x>']);
  expect(referencesOf(undefined, '<c@x> <d@x>')).toEqual(['<c@x>']);
  expect(referencesOf(undefined, undefined)).toEqual([]);
});

test('addresses and text in comments or quotes are not taken for ids', () => {
  expect(
    referencesOf(undefined, '<c@x> (Ada\'s message of "Mon, 3 Nov" <ada@example.com>)'),
  ).toEqual(['<c@x>']);
  expect(referencesOf(undefined, 'Your message of "Mon <3 Nov>" <c@x>')).toEqual(['<c@x>']);
  expect(referencesOf('(a \\) tricky comment <no@x>) <a@x>', undefined)).toEqual(['<a@x>']);
});

test('folded, repeated and unfinished ids are cleaned up', () => {
  expect(referencesOf('<a@\r\n x>\r\n\t<b@x> <a@x> <> <c@x', undefined)).toEqual([
    '<a@x>',
    '<b@x>',
  ]);
});

test('a long chain keeps the first message and the nearest ancestors', () => {
  const chain = Array.from({ length: 40 }, (_, i) => `<${i}@x>`);

  const references = referencesOf(chain.slice(0, 39).join(' '), '<39@x>');

  expect(references).toHaveLength(20);
  expect(references[0]).toBe('<0@x>');
  expect(references.slice(1)).toEqual(chain.slice(21));
});

test('a Message-ID is read with or without brackets, and a missing one stays empty', () => {
  expect(messageIdOf(' <a@x> ')).toBe('<a@x>');
  expect(messageIdOf('a@x')).toBe('<a@x>');
  for (const header of [undefined, '', '   ', 'not an id', '<>']) {
    expect(messageIdOf(header)).toBe('');
  }
});
