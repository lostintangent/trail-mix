import { expect, test } from 'bun:test';
import { asksAgain } from './query-client.ts';

const UNANSWERED = [
  'Failed to fetch',
  'NetworkError when attempting to fetch resource.',
  'Load failed',
];
const ANSWERED = Object.assign(new Error('The Mailroom is restarting.'), { status: 503 });

test('a query asks again three times while the browser says it’s online, though no answer came', () => {
  for (const error of [...UNANSWERED.map((said) => new TypeError(said)), ANSWERED]) {
    expect([0, 1, 2, 3].map((failures) => asksAgain(failures, error, false))).toEqual([
      true,
      true,
      true,
      false,
    ]);
  }
});

test('a request that got no answer while the browser says it’s offline isn’t asked again', () => {
  for (const said of UNANSWERED) expect(asksAgain(0, new TypeError(said), true)).toBe(false);
  // An answer came, so the network did, whatever the browser says.
  expect(asksAgain(0, ANSWERED, true)).toBe(true);
});
