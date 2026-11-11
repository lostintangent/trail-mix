import { expect, test } from 'bun:test';
import type { MessageRef } from '../../mail/core/index.ts';
import {
  avatarUrl,
  imageUrl,
  messageUrl,
  partUrl,
  readAvatarPath,
  readMessagePath,
} from './urls.ts';

const ref = (path: string, account = 'personal'): MessageRef => ({
  account,
  path,
  uidValidity: 1_700_000_000,
  uid: 4_294_967_295,
});

/** What a route sees: the path as a browser sends it, after URL parsing. */
const pathOf = (url: string) => new URL(url, 'https://mail.example.com').pathname;

test('a message and its parts read back from their URLs, whatever their folder is called', () => {
  const folders = [
    'INBOX',
    'Projects/Toy Box',
    '[Gmail]/Sent Mail',
    'Rechnungen/März',
    'Q&A?#100%',
    "Bob's (old) mail!*",
    'a/b/c/../d',
  ];

  for (const path of folders) {
    expect(readMessagePath(pathOf(messageUrl(ref(path))))).toEqual({ ref: ref(path) });
    expect(readMessagePath(pathOf(partUrl(ref(path), '2')))).toEqual({
      ref: ref(path),
      attachmentId: '2',
    });
  }
});

test('a folder path stays one segment, and each URL is safe to name in a Content-Security-Policy', () => {
  const url = partUrl(ref("Projects/Bob's (old) mail"), '0');

  expect(url).toBe(
    '/messages/personal/Projects%2FBob%27s%20%28old%29%20mail/1700000000/4294967295/0',
  );
});

test('a path that names no message reads as none', () => {
  const paths = [
    '/messages/personal/INBOX/1',
    '/messages/personal/INBOX/1/2/3/4',
    '/messages/personal/INBOX/0/2',
    '/messages/personal/INBOX/1/02',
    '/messages/personal/INBOX/1/4294967296',
    '/messages/personal/INBOX/1/-2',
    '/messages/personal/INBOX/1/2e3',
    '/messages/personal/%E0%A4%A/1/2',
    '/messages/personal/INBOX/1/2/',
    '/images/personal/INBOX/1/2',
  ];

  for (const path of paths) expect(readMessagePath(path)).toBeNull();
});

test('a remote image goes through the proxy with its whole address as one parameter', () => {
  const remote = 'https://cdn.example.com/a.png?w=600&h=400#top';
  const url = new URL(imageUrl(remote), 'https://mail.example.com');

  expect(url.pathname).toBe('/images');
  expect(url.searchParams.get('url')).toBe(remote);
});

test('an avatar reads back as its key, and any other path names none', () => {
  for (const key of ['news.example.com', 'xn--bcher-kva.example']) {
    expect(readAvatarPath(pathOf(avatarUrl(key)))).toBe(key);
  }
  for (const path of [
    '/avatars',
    '/avatars/',
    '/avatars/a/b',
    '/avatars/a%2Fb',
    '/avatars/News.Example',
    '/avatars/%E0%A4%A',
    '/images',
  ]) {
    expect(readAvatarPath(path)).toBeNull();
  }
  expect(readAvatarPath(`/avatars/${'a'.repeat(254)}`)).toBeNull();
});
