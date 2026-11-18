import type { Locator, Page, Request, Route } from 'playwright';

/**
 * What the e2e suites share to drive the app: where things lie in it, how to reach them at either
 * size, and how to hold or slow what a page asks for, so what it shows meanwhile is its own doing.
 */

export const reader = (page: Page) => page.getByRole('region', { name: 'Reader' });

/** What a toast says, as drawn first. Its words are also announced, in a hidden live region. */
export const toast = (page: Page, text: RegExp) =>
  page.getByText(text).filter({ visible: true }).first();

/**
 * The chips of a composer's To, Cc or Bcc, as each reads: a name and its address, an address, or
 * text that names none and says so.
 */
export const chipsIn = (composer: Locator, field: 'To' | 'Cc' | 'Bcc') =>
  composer
    .getByRole('group', { name: field, exact: true })
    .locator('[data-chip]')
    .evaluateAll((chips) =>
      chips.map((chip) => {
        const read = chip.cloneNode(true) as Element;
        for (const extra of read.querySelectorAll('button, [role="tooltip"], [popover]')) {
          extra.remove();
        }
        return read.textContent ?? '';
      }),
    );

/** Whether a control is on screen and can be used. A pane off a phone's screen is inert. */
export async function reachable(control: Locator): Promise<boolean> {
  return (await control.isVisible()) && control.evaluate((element) => !element.closest('[inert]'));
}

/**
 * Goes to a view: a unified one by its name, or an account's folder. On a phone it goes back from
 * the reader and opens the folders when the view is off the screen.
 */
export async function goTo(page: Page, view: string, account?: string) {
  const back = reader(page).getByRole('button', { name: 'Back', exact: true });
  if (await reachable(back)) await back.click();
  const button = account
    ? page
        .getByRole('region', { name: account })
        .getByRole('button', { name: new RegExp(`^${view}( \\d+)?$`) })
    : page.getByRole('button', { name: new RegExp(`^${view}`) }).first();
  const folders = page.getByRole('button', { name: 'Folders', exact: true });
  if (!(await reachable(button)) && (await reachable(folders))) await folders.click();
  await button.click();
}

/** The subject the reader shows, once it shows the selected conversation. */
export async function shownSubject(page: Page): Promise<string> {
  const shown = await page.waitForFunction(() => {
    const title = document.querySelector('section[aria-label="Reader"] h1')?.textContent;
    const selected = document.querySelector('[role="option"][aria-selected="true"]');
    return title && selected?.textContent?.includes(title) ? title : undefined;
  });
  return (await shown.jsonValue()) as string;
}

/**
 * Waits until the reader shows each message open with its body, or exactly `count` of them: HTML in
 * its frame, or plain text, and neither still on its way nor failed.
 */
export async function bodiesShown(page: Page, count?: number, timeout?: number) {
  await page.waitForFunction(
    (count) => {
      const sheets = [...document.querySelectorAll('section[aria-label="Reader"] article')];
      return (
        (count === undefined ? sheets.length > 0 : sheets.length === count) &&
        sheets.every(
          (sheet) =>
            !sheet.querySelector('[role="alert"], [aria-busy="true"]') &&
            [...sheet.querySelectorAll('iframe')].every(
              (frame) => frame.style.visibility === 'visible',
            ),
        )
      );
    },
    count,
    { timeout },
  );
}

/** Waits for two more frames to paint, and for what they report to be delivered. */
export const painted = (page: Page) =>
  page.evaluate(
    () =>
      new Promise((done) =>
        requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(done, 0))),
      ),
  );

/** Every console error and failed response a page meets from now on, for a test to expect none. */
export function problems(page: Page): string[] {
  const met: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') met.push(`console: ${message.text()}`);
  });
  page.on('response', (response) => {
    if (response.status() >= 400) met.push(`${response.status()} ${response.url()}`);
  });
  return met;
}

/**
 * What a page asks for that a test holds or slows: a query or command by its name, any request
 * whose address a pattern matches, such as a chunk of code, or any ask of the Mailroom a check picks.
 */
export type Asked = string | RegExp | ((request: Request) => boolean);

/**
 * Holds what a page asks for until released, as a slow Mailroom or network would. `requested`
 * settles as the first is asked. The release lets every one held go on to any route set before,
 * then stops holding.
 */
export async function hold(page: Page, asked: Asked) {
  const [where, isAsked] = routed(asked);
  const released = Promise.withResolvers<void>();
  const requested = Promise.withResolvers<Request>();
  const held: Promise<void>[] = [];
  const holding = (route: Route) => {
    if (!isAsked(route.request())) return route.fallback();
    requested.resolve(route.request());
    // A request the page gave up on meanwhile, as a superseded refetch is, is already handled.
    const through = released.promise.then(() => route.fallback().catch(() => {}));
    held.push(through);
    return through;
  };
  await page.route(where, holding);
  return {
    requested: requested.promise,
    async release() {
      released.resolve();
      await Promise.all(held);
      await page.unroute(where, holding);
    },
  };
}

/**
 * Has each answer to what a page asks for come `ms` late, while the Mailroom hears of it at once,
 * counting how many were asked and answered until `restore` stops it.
 */
export async function slow(page: Page, asked: Asked, ms: number) {
  const [where, isAsked] = routed(asked);
  const counts = { asked: 0, answered: 0 };
  const slowing = async (route: Route) => {
    if (!isAsked(route.request())) return route.fallback();
    counts.asked++;
    try {
      const response = await route.fetch();
      await new Promise((done) => setTimeout(done, ms));
      await route.fulfill({ response });
      counts.answered++;
    } catch {
      // A request the page gave up on meanwhile, as a superseded refetch is, needs no answer.
    }
  };
  await page.route(where, slowing);
  return Object.assign(counts, { restore: () => page.unroute(where, slowing) });
}

/**
 * Where to route what `asked` names, and whether a request routed there is one. A query carries its
 * name in its address, and a command in its body.
 */
function routed(asked: Asked): [string | RegExp, (request: Request) => boolean] {
  if (asked instanceof RegExp) return [asked, () => true];
  if (typeof asked === 'function') return ['**/_serverFn/**', asked];
  return [
    '**/_serverFn/**',
    (request) =>
      request.method() === 'GET'
        ? decodeURIComponent(request.url()).includes(`{"t":1,"s":"${asked}"}`)
        : !!request.postData()?.includes(`"${asked}"`),
  ];
}
