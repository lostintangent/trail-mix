import { describe, expect, test } from 'bun:test';
import { BODY_LIMITS, evictions, isKept, keptOf, type Held, type Persisted } from './kept.ts';

// The query keys the Mailroom's client gives its snapshots.
const ref = { account: 'a', path: 'INBOX', validity: 1, uid: 1 };
const keys = {
  accounts: ['accounts'],
  signIns: ['accounts', 'sign-ins'],
  signInPresets: ['sign-in-presets'],
  thisDevice: ['this-device'],
  folders: ['folders'],
  outbox: ['outbox'],
  page: (view: unknown, at: number) => ['conversations', view, at],
  bundlePage: (id: string, at: number) => ['bundle', id, at],
  conversation: (id: string) => ['conversation', id],
  body: (message: typeof ref) => ['body', message],
};

const persisted = (queryKey: readonly unknown[], data: unknown): Persisted => ({
  queryKey,
  queryHash: JSON.stringify(queryKey),
  state: { data, dataUpdatedAt: 1 },
  buster: '1',
});

describe('what is kept', () => {
  const bundle = 'a:trailmix-demo%2Ftoy-box';
  const kept = (list: (readonly unknown[])[]) => list.filter((key) => isKept(key));

  test('the snapshots that show mail, and nothing about signing in or this device', () => {
    const showing = [
      keys.accounts,
      keys.folders,
      keys.outbox,
      keys.conversation('c1'),
      keys.body(ref),
    ];
    expect(kept(showing)).toEqual(showing);
    expect(kept([keys.signIns, keys.signInPresets, keys.thisDevice])).toEqual([]);
  });

  test('a list or a bundle keeps its first page, which is what opens first, and no page further down', () => {
    const inbox = { in: 'inbox' };
    const first = [keys.page(inbox, 0), keys.bundlePage(bundle, 0)];
    const further = [keys.page(inbox, 50), keys.page(inbox, 100), keys.bundlePage(bundle, 50)];
    expect(kept([...first, ...further])).toEqual(first);
  });

  test('a body knows its size, and nothing else counts', () => {
    expect(keptOf(persisted(keys.body(ref), { html: 'x'.repeat(1000) })).bytes).toBe(1011);
    expect(keptOf(persisted(keys.accounts, [{ id: 'a' }])).bytes).toBe(0);
  });
});

describe('what goes', () => {
  const body = (key: string, at: number, bytes = 10): Held => ({ key, kind: 'body', at, bytes });

  test('nothing, while the bodies fit', () => {
    expect(evictions([body('a', 1), body('b', 2)])).toEqual([]);
  });

  test('the bodies fetched longest ago, past the count', () => {
    const held = [body('old', 1), body('new', 3), body('mid', 2)];
    expect(evictions(held, { count: 2, bytes: Infinity })).toEqual(['old']);
  });

  test('the bodies fetched longest ago, past the bytes, even small ones', () => {
    const held = [body('big', 3, 60), body('mid', 2, 50), body('small', 1, 1)];
    expect(evictions(held, { count: 10, bytes: 100 })).toEqual(['mid', 'small']);
  });

  test('never anything but a body', () => {
    const list: Held = { key: 'list', kind: 'conversations', at: 0, bytes: 0 };
    const many = Array.from({ length: BODY_LIMITS.count + 1 }, (_, n) => body(`b${n}`, n + 1));
    expect(evictions([list, ...many])).toEqual(['b0']);
  });
});
