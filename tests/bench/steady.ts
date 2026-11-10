import type { Page } from 'playwright';

/** How long a page must go without a request in flight to count as idle. */
const IDLE_MS = 500;

/**
 * What a page is doing besides what a bench times: its requests in flight and the hints its socket
 * receives. Watch a page before it navigates, so its socket is seen from the start.
 */
export function watch(page: Page) {
  let inFlight = 0;
  let quietSince = performance.now();
  let hints = 0;
  page.on('request', () => void (inFlight += 1));
  const done = () => {
    inFlight -= 1;
    if (inFlight === 0) quietSince = performance.now();
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
      await page.getByText('Up to date').waitFor({ state: 'attached', timeout: 180_000 });
      while (inFlight > 0 || performance.now() - quietSince < IDLE_MS) {
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
