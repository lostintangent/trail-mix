import type { Page, Request } from 'playwright';
import { mailIsIn } from '../mailIsIn.ts';

/** How long a page must go without a request in flight to count as idle. */
const IDLE_MS = 500;

/**
 * What a page is doing besides what a bench times: its requests in flight and the hints its socket
 * receives. Watch a page before it navigates, so its socket is seen from the start.
 */
export type Watch = ReturnType<typeof watch>;

export function watch(page: Page) {
  const inFlight = new Set<Request>();
  let quietSince = performance.now();
  let hints = 0;
  page.on('request', (request) => void inFlight.add(request));
  const done = (request: Request) => {
    inFlight.delete(request);
    if (inFlight.size === 0) quietSince = performance.now();
  };
  page.on('requestfinished', done);
  page.on('requestfailed', done);
  page.on('websocket', (socket) => socket.on('framereceived', () => void (hints += 1)));

  return {
    /**
     * Waits for steady state: the Mailroom up to date, and no request in flight for `IDLE_MS`. A
     * section timed after this measures the page, not the Mailroom catching up.
     */
    async steady() {
      await mailIsIn(page, 180_000);
      const since = performance.now();
      while (inFlight.size > 0 || performance.now() - quietSince < IDLE_MS) {
        if (performance.now() - since > 15_000) {
          const urls = [...inFlight].map((request) => request.url().slice(0, 120));
          throw new Error(`The page never went idle. Still in flight: ${urls.join(', ')}`);
        }
        await page.waitForTimeout(50);
      }
    },
    /** Runs a timed section and prints how many hints arrived during it, since each is a refetch. */
    async during<T>(section: string, timed: () => Promise<T>): Promise<T> {
      const before = hints;
      const result = await timed();
      console.log(`${section}: ${hints - before} hints arrived while it was timed.`);
      return result;
    },
  };
}
