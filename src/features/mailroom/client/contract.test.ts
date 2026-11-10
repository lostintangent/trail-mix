import { expect, test } from 'bun:test';
import {
  COMMANDS,
  MAX_FILE_BYTES,
  QUERIES,
  readCall,
  receivedCall,
  sendable,
  type Call,
  type CommandName,
} from './contract.ts';

test('a query or command on the contract reaches the Mailroom with its arguments', () => {
  const view = { in: 'inbox' };

  expect(readCall(QUERIES, { name: 'conversations', args: [view] })).toEqual({
    name: 'conversations',
    args: [view],
  });
  expect(readCall(COMMANDS, { name: 'eraseEverything', args: [] })).toEqual({
    name: 'eraseEverything',
    args: [],
  });
});

test('nothing else a Durable Object answers can be called from a browser', () => {
  const outside = ['fetch', 'alarm', 'webSocketMessage', 'source', 'part', 'constructor'];
  const inherited = ['toString', '__proto__', 'hasOwnProperty'];

  for (const name of [...outside, ...inherited]) {
    expect(() => readCall(QUERIES, { name, args: [] })).toThrow(TypeError);
    expect(() => readCall(COMMANDS, { name, args: [] })).toThrow(TypeError);
  }
});

// Queries travel as GET, which the Worker lets through without asking which site sent it.
test('a command can’t travel as a query', () => {
  for (const name of COMMANDS) {
    expect(() => readCall(QUERIES, { name, args: [] })).toThrow(TypeError);
  }
});

test('a call that isn’t a name and a list of arguments is refused', () => {
  for (const input of [
    null,
    'accounts',
    { name: 'accounts' },
    { name: 'accounts', args: 'all' },
    { name: ['accounts'], args: [] },
  ]) {
    expect(() => readCall(QUERIES, input)).toThrow(TypeError);
  }
});

test('a call carrying files travels as form data and reaches the Mailroom with their bytes', async () => {
  const image = new File([new Uint8Array([137, 80, 78, 71])], 'chart.png', { type: 'image/png' });
  const notes = new File(['Bring a jacket.'], 'notes.txt', { type: 'text/plain' });
  const draft = {
    subject: 'Lunch',
    attachments: [{ file: image, contentId: 'chart@trailmix.invalid' }, { file: notes }],
  };
  const sent = sendable({ name: 'saveDraft', args: [draft, { uid: 7 }] });
  expect(sent).toBeInstanceOf(FormData);

  expect(await receivedCall(COMMANDS, sent)).toEqual({
    name: 'saveDraft',
    args: [
      {
        subject: 'Lunch',
        attachments: [
          {
            file: {
              name: 'chart.png',
              type: 'image/png',
              content: new Uint8Array([137, 80, 78, 71]),
            },
            contentId: 'chart@trailmix.invalid',
          },
          {
            file: {
              name: 'notes.txt',
              type: 'text/plain',
              content: new TextEncoder().encode('Bring a jacket.'),
            },
          },
        ],
      },
      { uid: 7 },
    ],
  });
});

test('a call without files travels as it is', async () => {
  const call: Call<CommandName> = { name: 'setFlags', args: [[{ uid: 1 }], { seen: true }] };
  expect(sendable(call)).toBe(call);
  expect(await receivedCall(COMMANDS, call)).toEqual(call);
});

const form = (call: unknown, files: File[] = []) => {
  const data = new FormData();
  data.set('call', JSON.stringify(call));
  files.forEach((file, n) => data.set(`file${n}`, file));
  return data;
};

test('form data gets no further than JSON would', async () => {
  await expect(receivedCall(COMMANDS, form({ name: 'source', args: [] }))).rejects.toThrow(
    TypeError,
  );
});

test('a call can’t name a file it didn’t send', async () => {
  await expect(
    receivedCall(COMMANDS, form({ name: 'saveDraft', args: [{ file: { $file: 1 } }] })),
  ).rejects.toThrow(TypeError);
});

test('the files on one call can’t outgrow what a Durable Object call holds', async () => {
  const big = new File([new Uint8Array(MAX_FILE_BYTES + 1)], 'big.bin');
  await expect(
    receivedCall(COMMANDS, form({ name: 'saveDraft', args: [{ file: { $file: 0 } }] }, [big])),
  ).rejects.toThrow(TypeError);
});
