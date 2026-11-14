import { afterAll, beforeAll, expect, test } from 'bun:test';
import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { isCaughtUp, listen, SETTLE_MS } from './hints.ts';
import { keys } from './queries.ts';

/** A stand-in for the browser's WebSocket, which a test opens and drops by hand. */
class Socket {
  static readonly OPEN = 1;
  static made: Socket[] = [];
  readyState = 0;
  onopen?: () => void;
  onmessage?: (event: { data: unknown }) => void;
  onclose?: () => void;
  constructor(readonly url: URL) {
    Socket.made.push(this);
  }
  open() {
    this.readyState = Socket.OPEN;
    this.onopen?.();
  }
  close() {
    this.readyState = 3;
  }
}

const browser = globalThis as unknown as Record<string, unknown>;
const held = {
  WebSocket: browser.WebSocket,
  location: browser.location,
  document: browser.document,
};
beforeAll(() => {
  browser.WebSocket = Socket;
  browser.location = { href: 'https://mail.example.com/' };
  browser.document = {
    visibilityState: 'visible',
    addEventListener() {},
    removeEventListener() {},
  };
});
afterAll(() => Object.assign(browser, held));

/** A browser's cache holding what a page fetched before its socket opened. */
function fetched() {
  const queryClient = new QueryClient();
  queryClient.setQueryData(keys.accounts, [{ id: 'personal', status: 'syncing' }]);
  queryClient.setQueryData(keys.folders, []);
  const isStale = () =>
    [keys.accounts, keys.folders].map((key) => queryClient.getQueryState(key)?.isInvalidated);
  return { queryClient, isStale };
}

test('the socket’s first open refetches what the page fetched before it, whose hints it missed', () => {
  const { queryClient, isStale } = fetched();
  const stop = listen(queryClient);
  expect(Socket.made[0]!.url.href).toBe('wss://mail.example.com/updates');
  expect(isStale()).toEqual([false, false]);
  Socket.made[0]!.open();
  expect(isStale()).toEqual([true, true]);
  stop();
});

test('a burst of hints, as a first sync sends, can’t keep the list from refreshing', async () => {
  const queryClient = new QueryClient();
  // The list on screen, whose every fetch takes a moment and answers with the mail it found.
  let found = 0;
  const shown: number[] = [];
  const list = new QueryObserver(queryClient, {
    queryKey: keys.conversations({ in: 'inbox' }),
    queryFn: async () => {
      const now = ++found;
      await Bun.sleep(SETTLE_MS / 2);
      return now;
    },
  });
  const unsubscribe = list.subscribe(({ data }) => {
    if (data !== undefined && shown.at(-1) !== data) shown.push(data);
  });
  const stop = listen(queryClient);
  const [socket] = Socket.made.slice(-1);
  socket!.open();
  const hint = JSON.stringify({
    changed: 'conversations',
    folder: { account: 'personal', path: 'INBOX' },
  });
  // A hint every 20 ms for two seconds.
  for (let sent = 0; sent < 100; sent++) {
    socket!.onmessage?.({ data: hint });
    await Bun.sleep(20);
  }
  // The list showed fresh mail during the burst, not only after it.
  expect(shown.length).toBeGreaterThan(4);
  // And the burst's last hint is refetched for, once it has had its turn.
  await Bun.sleep(SETTLE_MS * 2);
  expect(queryClient.getQueryState(keys.conversations({ in: 'inbox' }))?.isInvalidated).toBe(false);
  expect(shown.at(-1)).toBe(found);
  unsubscribe();
  stop();
});

test('the hints one change sends refetch what they name once, together', async () => {
  const queryClient = new QueryClient();
  // The list and the counts on screen, each counting how often it is asked.
  const asked = { list: 0, folders: 0 };
  const observers = [
    new QueryObserver(queryClient, {
      queryKey: keys.conversations({ in: 'inbox' }),
      queryFn: () => ++asked.list,
    }),
    new QueryObserver(queryClient, { queryKey: keys.folders, queryFn: () => ++asked.folders }),
  ];
  const unsubscribe = observers.map((observer) => observer.subscribe(() => {}));
  const stop = listen(queryClient);
  const [socket] = Socket.made.slice(-1);
  socket!.open();
  await Bun.sleep(10);
  const before = { ...asked };
  // A conversation read in a folder it shares with Sent, then the counts the server lists after.
  const send = (hint: object) => socket!.onmessage?.({ data: JSON.stringify(hint) });
  send({ changed: 'conversations', folder: { account: 'personal', path: 'INBOX' } });
  await Bun.sleep(2);
  send({ changed: 'conversations', folder: { account: 'personal', path: 'Sent' } });
  await Bun.sleep(10);
  send({ changed: 'folders', account: 'personal' });
  await Bun.sleep(SETTLE_MS * 2);
  expect(asked).toEqual({ list: before.list + 1, folders: before.folders + 1 });
  for (const done of unsubscribe) done();
  stop();
});

test('a page catches up once its socket has opened and what it held is asked again', async () => {
  const queryClient = new QueryClient();
  const { promise: answered, resolve: answer } = Promise.withResolvers<number>();
  const list = new QueryObserver(queryClient, {
    queryKey: keys.conversations({ in: 'inbox' }),
    queryFn: () => answered,
  });
  const unsubscribe = list.subscribe(() => {});
  const stop = listen(queryClient);
  expect(isCaughtUp(queryClient)).toBe(false);
  Socket.made.at(-1)!.open();
  // The list on screen is asked again, and until it answers the page hasn't caught up.
  await Bun.sleep(10);
  expect(isCaughtUp(queryClient)).toBe(false);
  answer(1);
  await Bun.sleep(10);
  expect(isCaughtUp(queryClient)).toBe(true);
  unsubscribe();
  stop();
});

test('a socket that can’t open, as with no network, leaves the page caught up at its first try', () => {
  const queryClient = new QueryClient();
  const stop = listen(queryClient);
  Socket.made.at(-1)!.onclose?.();
  expect(isCaughtUp(queryClient)).toBe(true);
  stop();
});
