import { describe, expect, test } from 'bun:test';
import { placeAt, type Message } from '../../mail/core/index.ts';
import { MOST_NOTICES, noticesOf } from './notices.ts';
import { noticeIn, pushOf } from './push.ts';

const ACCOUNTS: Record<string, string> = { personal: 'Personal', work: 'Work' };
const nameOf = (id: string) => ACCOUNTS[id];

function message(uid: number, change: Partial<Message> = {}): Message {
  return {
    account: 'personal',
    path: 'INBOX',
    uidValidity: 7,
    uid,
    messageId: `<${uid}@example.com>`,
    references: [],
    from: { name: 'Ada Park', email: 'ada@example.com' },
    to: [{ email: 'sam@trailmix.test' }],
    cc: [],
    subject: 'Trip photos',
    date: `2026-11-10T12:00:0${uid % 10}Z`,
    preview: 'Here are the ones from the ridge.',
    flags: { seen: false, flagged: false, answered: false, draft: false },
    hasAttachments: false,
    verified: false,
    conversation: `personal:mail:${uid}`,
    ...change,
  };
}

describe('a notice', () => {
  test('names the sender, says the subject and preview, and opens its conversation', () => {
    const [notice] = noticesOf([message(1)], nameOf);
    expect(notice).toEqual({
      title: 'Ada Park',
      body: 'Trip photos\nHere are the ones from the ridge.',
      tag: 'personal:mail:1',
      navigate: '/?open=personal:mail:1',
      message: { account: 'personal', path: 'INBOX', uidValidity: 7, uid: 1 },
    });
    expect(placeAt(notice!.navigate)).toEqual({ view: { in: 'inbox' }, open: 'personal:mail:1' });
  });

  test('names a sender with no name by their address, and leaves out what is empty', () => {
    const [notice] = noticesOf(
      [message(1, { from: { email: 'ada@example.com' }, preview: ' ' })],
      nameOf,
    );
    expect(notice).toMatchObject({ title: 'ada@example.com', body: 'Trip photos' });
  });

  test('is one per conversation, about its newest news, newest conversation first', () => {
    const notices = noticesOf(
      [
        message(1, { conversation: 'personal:mail:a', subject: 'Older' }),
        message(3, { conversation: 'personal:mail:b' }),
        message(2, { conversation: 'personal:mail:a', subject: 'Newer' }),
      ],
      nameOf,
    );
    expect(notices.map(({ tag, body }) => [tag, body.split('\n')[0]])).toEqual([
      ['personal:mail:b', 'Trip photos'],
      ['personal:mail:a', 'Newer'],
    ]);
  });

  test('clips a long subject, so a push stays inside its size', () => {
    const [notice] = noticesOf([message(1, { subject: 'x'.repeat(500) })], nameOf);
    expect(notice!.body.split('\n')[0]).toHaveLength(200);
    expect(notice!.body.split('\n')[0]!.endsWith('…')).toBe(true);
  });
});

describe('more conversations with news than one wake tells one by one', () => {
  const news = [
    message(1),
    message(2, { account: 'work', conversation: 'work:mail:2' }),
    message(3),
    message(4),
    message(5, { account: 'work', conversation: 'work:mail:5' }),
  ];

  test('become one summary of every message, naming the accounts, that opens the Inbox', () => {
    expect(noticesOf(news, nameOf)).toEqual([
      { title: '5 new messages', body: 'In Personal and Work', tag: 'news', navigate: '/' },
    ]);
  });

  test('start one past the most told one by one', () => {
    expect(noticesOf(news.slice(0, MOST_NOTICES), nameOf)).toHaveLength(MOST_NOTICES);
    expect(noticesOf(news.slice(0, MOST_NOTICES + 1), nameOf)).toHaveLength(1);
  });
});

describe('a push', () => {
  test('is a mutable Declarative Web Push message carrying the message to act on', () => {
    const [notice] = noticesOf([message(1)], nameOf);
    expect(pushOf(notice!)).toEqual({
      web_push: 8030,
      mutable: true,
      notification: {
        title: 'Ada Park',
        body: 'Trip photos\nHere are the ones from the ridge.',
        tag: 'personal:mail:1',
        navigate: '/?open=personal:mail:1',
        lang: 'en',
        data: { message: { account: 'personal', path: 'INBOX', uidValidity: 7, uid: 1 } },
      },
    });
  });

  test('is read back into its notice, with or without a message', () => {
    const notices = noticesOf([message(1)], nameOf);
    const summary = noticesOf(
      [1, 2, 3, 4].map((uid) => message(uid)),
      nameOf,
    );
    for (const notice of [...notices, ...summary]) {
      expect(noticeIn(JSON.parse(JSON.stringify(pushOf(notice))))).toEqual(notice);
    }
  });

  test('that is not a notice reads as none, and a malformed message ref is dropped', () => {
    expect(noticeIn('hello')).toBeUndefined();
    expect(noticeIn({ notification: { title: 'Hi', navigate: '/' } })).toBeUndefined();
    expect(noticeIn({ web_push: 8030, notification: { title: 'Hi' } })).toBeUndefined();
    const forged = {
      web_push: 8030,
      notification: {
        title: 'Hi',
        navigate: '/',
        data: { message: { account: 'a', path: 'INBOX', uid: 'x' } },
      },
    };
    expect(noticeIn(forged)).toEqual({ title: 'Hi', body: '', tag: '', navigate: '/' });
  });

  test('stays far inside the 3,993 bytes a push can carry, however long its words', () => {
    const [notice] = noticesOf(
      [
        message(1, {
          from: { name: 'é'.repeat(400), email: 'a@b.c' },
          subject: '😀'.repeat(400),
          preview: '𝕏'.repeat(400),
        }),
      ],
      nameOf,
    );
    expect(new TextEncoder().encode(JSON.stringify(pushOf(notice!))).byteLength).toBeLessThan(
      3_993,
    );
  });
});
