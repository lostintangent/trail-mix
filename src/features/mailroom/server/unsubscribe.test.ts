import { expect, mock, test } from 'bun:test';
import { unsubscribeAt } from './unsubscribe.ts';

const standIn = 'https://127.0.0.1:8443';

test('posts only over HTTPS to a public host, or to the stand-in it was given, with no credentials', async () => {
  const post = mock((url: URL) => Promise.resolve(new Response(url.href)));
  for (const address of [
    'http://lists.example.com/u',
    'https://ada@lists.example.com/u',
    'https://:secret@lists.example.com/u',
    'https://10.0.0.1/u',
    'https://lists.internal/u',
    'https://127.0.0.1:9443/u',
    'http://127.0.0.1:8443/u',
  ]) {
    expect((await unsubscribeAt(address, post, standIn)).taken).toBe(false);
  }
  expect(await unsubscribeAt('https://lists.example.com/u', post, standIn)).toEqual({
    taken: true,
  });
  expect(await unsubscribeAt(`${standIn}/u`, post, standIn)).toEqual({ taken: true });
  const posted = post.mock.calls.map(([url]) => url.href);
  expect(posted).toEqual(['https://lists.example.com/u', `${standIn}/u`]);
});
