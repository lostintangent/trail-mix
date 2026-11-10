import { describe, expect, test } from 'bun:test';
import { answerFor, isShellOf } from './requests.ts';

const ORIGIN = 'https://mail.example.com';
const KEPT = new Set(['/assets/main-abc123.js', '/assets/main-def456.css', '/icons/icon-192.png']);
const ask = (url: string, { method = 'GET', mode = 'cors' } = {}) =>
  answerFor({ method, mode, url: new URL(url, ORIGIN).href }, ORIGIN, KEPT);

describe('what the worker answers', () => {
  test('a page load, at any address, is the shell', () => {
    for (const path of ['/', '/?view=archive', '/anything/at/all']) {
      expect(ask(path, { mode: 'navigate' })).toBe('shell');
    }
  });

  test('a built file it keeps comes from what it keeps', () => {
    expect(ask('/assets/main-abc123.js')).toBe('kept');
    expect(ask('/icons/icon-192.png', { mode: 'no-cors' })).toBe('kept');
  });

  test('queries, commands, the socket, message parts, images and anything unknown go to the network', () => {
    for (const path of [
      '/_serverFn/abc?payload=%7B%7D',
      '/updates',
      '/messages/personal/INBOX/1/2',
      '/images?url=https%3A%2F%2Fexample.org%2Fa.png',
      '/health',
      '/assets/main-old999.js',
    ]) {
      expect({ path, answer: ask(path) }).toEqual({ path, answer: 'network' });
    }
  });

  test('nothing but a GET from its own origin is answered', () => {
    expect(ask('/_serverFn/abc', { method: 'POST' })).toBe('network');
    expect(ask('/', { method: 'POST', mode: 'navigate' })).toBe('network');
    expect(ask('https://cdn.example.org/assets/main-abc123.js')).toBe('network');
    expect(ask('https://team.cloudflareaccess.com/', { mode: 'navigate' })).toBe('network');
  });
});

describe('a shell of the worker’s build', () => {
  const shell = (...assets: string[]) =>
    `<!doctype html><html><head>${assets.map((a) => `<link rel="modulepreload" href="${a}">`).join('')}</head></html>`;

  test('names only files the worker keeps', () => {
    expect(isShellOf(shell('/assets/main-abc123.js', '/assets/main-def456.css'), KEPT)).toBe(true);
  });

  test('from a newer deployment names one it doesn’t, and isn’t kept', () => {
    expect(isShellOf(shell('/assets/main-abc123.js', '/assets/main-new789.js'), KEPT)).toBe(false);
  });

  test('that names no built file at all, such as a sign-in page, isn’t one', () => {
    expect(isShellOf('<html><body>Sign in</body></html>', KEPT)).toBe(false);
  });
});
