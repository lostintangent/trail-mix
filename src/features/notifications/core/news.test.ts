import { describe, expect, test } from 'bun:test';
import type { Envelope, MessageRef, SyncEvent } from '../../mail/core/index.ts';
import { NEWS_FOR_MS, newsIn, type Mark } from './news.ts';

const NOW = Date.parse('2026-11-10T12:00:00Z');
const NEVER_MOVED = { now: NOW, movedIn: () => false };

function arrived(uid: number, change: Partial<Envelope> = {}): SyncEvent {
  return {
    type: 'message',
    envelope: {
      account: 'personal',
      path: 'INBOX',
      uidValidity: 7,
      uid,
      messageId: `<${uid}@example.com>`,
      references: [],
      from: { name: 'Ada Park', email: 'ada@example.com' },
      to: [{ email: 'sam@trailmix.test' }],
      cc: [],
      subject: `Message ${uid}`,
      date: new Date(NOW - 60_000).toISOString(),
      preview: '',
      flags: { seen: false, flagged: false, answered: false, draft: false },
      hasAttachments: false,
      ...change,
    },
  };
}

const uids = ({ news }: { news: Envelope[] }) => news.map(({ uid }) => uid);

describe('news in an Inbox already read', () => {
  const mark: Mark = { uidValidity: 7, uid: 40 };

  test('is each unseen message above the mark, and the mark rises to the highest UID', () => {
    const read = newsIn([arrived(43), arrived(42), arrived(41)], mark, NEVER_MOVED);
    expect(uids(read)).toEqual([43, 42, 41]);
    expect(read.mark).toEqual({ uidValidity: 7, uid: 43 });
  });

  test('leaves out what the server reports seen, as mail read in another client', () => {
    const seen = { seen: true, flagged: false, answered: false, draft: false };
    expect(uids(newsIn([arrived(42, { flags: seen }), arrived(41)], mark, NEVER_MOVED))).toEqual([
      41,
    ]);
  });

  test('leaves out a message at or below the mark, as a folder starting over reports it again', () => {
    const read = newsIn(
      [{ type: 'reset', folder: { account: 'personal', path: 'INBOX' } }, arrived(40), arrived(12)],
      mark,
      NEVER_MOVED,
    );
    expect(uids(read)).toEqual([]);
    expect(read.mark).toEqual(mark);
  });

  test('leaves out mail dated more than a day ago, as old mail moved in by another client', () => {
    const old = new Date(NOW - NEWS_FOR_MS).toISOString();
    const lately = new Date(NOW - NEWS_FOR_MS + 1).toISOString();
    expect(
      uids(newsIn([arrived(42, { date: old }), arrived(41, { date: lately })], mark, NEVER_MOVED)),
    ).toEqual([41]);
  });

  test('leaves out a message the member moved in, as an undone archive brings it back', () => {
    const movedIn = (ref: MessageRef) => ref.uid === 42;
    const read = newsIn([arrived(42), arrived(41)], mark, { now: NOW, movedIn });
    expect(uids(read)).toEqual([41]);
    expect(read.mark).toEqual({ uidValidity: 7, uid: 42 });
  });

  test('keeps the mark where no message arrived', () => {
    const flags: SyncEvent = {
      type: 'flags',
      ref: { account: 'personal', path: 'INBOX', uidValidity: 7, uid: 41 },
      flags: { seen: true, flagged: false, answered: false, draft: false },
    };
    expect(newsIn([flags], mark, NEVER_MOVED)).toEqual({ news: [], mark });
  });
});

describe('an Inbox read for the first time', () => {
  test('has no news, and its mark starts at the highest UID', () => {
    const read = newsIn([arrived(43), arrived(42)], undefined, NEVER_MOVED);
    expect(uids(read)).toEqual([]);
    expect(read.mark).toEqual({ uidValidity: 7, uid: 43 });
  });

  test('later batches of that first sync, newest first, stay quiet below the mark', () => {
    const first = newsIn([arrived(43), arrived(42)], undefined, NEVER_MOVED);
    const second = newsIn([arrived(41), arrived(40)], first.mark, NEVER_MOVED);
    expect(uids(second)).toEqual([]);
    expect(second.mark).toEqual({ uidValidity: 7, uid: 43 });
  });

  test('is one whose server gave it a new UIDVALIDITY, so its renumbered mail stays quiet', () => {
    const read = newsIn(
      [arrived(52, { uidValidity: 8 }), arrived(51, { uidValidity: 8 })],
      { uidValidity: 7, uid: 40 },
      NEVER_MOVED,
    );
    expect(uids(read)).toEqual([]);
    expect(read.mark).toEqual({ uidValidity: 8, uid: 52 });
  });
});
