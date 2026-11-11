import { afterAll, beforeAll, expect, test } from 'bun:test';
import { QueryClient } from '@tanstack/react-query';
import { listen } from './hints.ts';
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
