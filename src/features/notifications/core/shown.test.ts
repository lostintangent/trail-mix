import { describe, expect, test } from 'bun:test';
import type { MessageRef } from '../../mail/core/index.ts';
import { pushOf } from './push.ts';
import { afterAct, clickOf, shownOf } from './shown.ts';

const MESSAGE: MessageRef = { account: 'personal', path: 'INBOX', uidValidity: 7, uid: 1 };
const ABOUT_ONE = pushOf({
  title: 'Ada Park',
  body: 'Trip photos',
  tag: 'personal:mail:1',
  navigate: '/?open=personal:mail:1',
  message: MESSAGE,
});
const SUMMARY = pushOf({
  title: '4 new messages',
  body: 'In Personal',
  tag: 'news',
  navigate: '/',
});

describe('a push the worker shows', () => {
  test('says what its notice says, and carries where it leads and its message', () => {
    expect(shownOf(ABOUT_ONE, false)).toEqual({
      title: 'Ada Park',
      options: {
        body: 'Trip photos',
        tag: 'personal:mail:1',
        lang: 'en',
        icon: '/icons/icon-192.png',
        data: { navigate: '/?open=personal:mail:1', message: MESSAGE },
      },
    });
  });

  test('offers Archive and Mark read where the platform shows buttons, and only about one message', () => {
    expect(shownOf(ABOUT_ONE, true).options.actions).toEqual([
      { action: 'archive', title: 'Archive' },
      { action: 'read', title: 'Mark read' },
    ]);
    expect(shownOf(SUMMARY, true).options).not.toHaveProperty('actions');
  });

  test('that carries no notice it can read still shows, as new mail that opens the Inbox', () => {
    expect(shownOf('not a notice', true)).toMatchObject({
      title: 'New mail',
      options: { body: '', tag: 'news', data: { navigate: '/' } },
    });
  });
});

describe('a tap or a button', () => {
  const data = shownOf(ABOUT_ONE, true).options.data;

  test('archives or marks read the message a button names, and leads to it if that fails', () => {
    expect(clickOf('archive', data)).toEqual({
      act: { action: 'archive', message: MESSAGE },
      navigate: '/?open=personal:mail:1',
    });
    expect(clickOf('read', data).act).toEqual({ action: 'read', message: MESSAGE });
  });

  test('anywhere else opens where the notification leads', () => {
    expect(clickOf('', data)).toEqual({ navigate: '/?open=personal:mail:1' });
    expect(clickOf('archive', shownOf(SUMMARY, true).options.data)).toEqual({ navigate: '/' });
  });

  test('opens only Trail Mix’s own addresses, whatever a notification carries', () => {
    for (const navigate of [
      'https://evil.example/',
      '//evil.example/',
      'javascript:alert(1)',
      42,
    ]) {
      expect(clickOf('', { navigate, message: MESSAGE }).navigate).toBe('/');
    }
    expect(clickOf('archive', { navigate: '/', message: { uid: 'x' } })).toEqual({ navigate: '/' });
  });
});

test('a button’s ask went through only if the Mailroom took it, so a lapsed sign-in opens the app', () => {
  expect(afterAct({ type: 'basic', ok: true })).toBe('done');
  expect(afterAct({ type: 'opaqueredirect', ok: false })).toBe('open');
  expect(afterAct({ type: 'basic', ok: false })).toBe('open');
  expect(afterAct('unreachable')).toBe('open');
});
