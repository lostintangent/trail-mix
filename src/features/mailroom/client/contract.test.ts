import { expect, test } from 'bun:test';
import { COMMANDS, QUERIES, readCall } from './contract.ts';

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
