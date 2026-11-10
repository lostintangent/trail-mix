import { afterEach, expect } from 'bun:test';
import type { Page, Request, Route } from 'playwright';
import { suite } from './suite.ts';

/**
 * Triage, end to end: the built app on workerd, with two browsers open on one member's demo mail.
 * The browser that acts shows the change at once, and the other shows it once the Mailroom's hint
 * reaches it. A fresh member each run starts from the seeded mailbox.
 */

const MEMBER = `triage-${Date.now()}@trailmix.test`;
const DESKTOP = { viewport: { width: 1440, height: 900 } };
const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true };
/** How soon every other open browser shows a change, as the triage step promises. */
const ELSEWHERE_MS = 5_000;

const app = suite({ vars: { DEV_MEMBER: MEMBER } });
// A test that fails leaves a screenshot of each page and what it showed, for CI to keep.
const { test } = app;

/** Every error a page threw during a test, which fails it. */
const errors: string[] = [];
afterEach(() => {
  expect(errors.splice(0)).toEqual([]);
});

/** A browser on the unified Inbox, once the Mailroom has filled it. */
async function inbox(size: typeof DESKTOP | typeof PHONE = DESKTOP): Promise<Page> {
  const page = await (await app.context(size)).newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(app.url);
  await page.getByText('Up to date').waitFor({ state: 'attached', timeout: 30_000 });
  return page;
}

/**
 * Holds every command this browser sends for a second, so what it shows before then can only be
 * its own doing, and the Mailroom's answer and hints come after. The release lets the held
 * commands through, then stops holding. Each request goes on to any route the test set before,
 * so a browser kept from hearing something stays deaf to it while commands are held.
 */
async function slowCommands(page: Page): Promise<() => Promise<void>> {
  const held: Promise<void>[] = [];
  const hold = (route: Route) => {
    const through = (async () => {
      if (route.request().method() === 'POST') await new Promise((done) => setTimeout(done, 1_000));
      // A fetch the app gave up on meanwhile, as a superseded refetch is, is already handled.
      await route.fallback().catch((error: unknown) => {
        if (!String(error).includes('already handled')) throw error;
      });
    })();
    held.push(through);
    return through;
  };
  await page.route('**/_serverFn/**', hold);
  return async () => {
    await Promise.all(held);
    await page.unroute('**/_serverFn/**', hold);
  };
}

/** A finger on the screen, through the browser's own touch input, as a phone's would come. */
async function finger(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  const touch = (type: 'touchStart' | 'touchMove' | 'touchEnd', x: number, y: number) =>
    cdp.send('Input.dispatchTouchEvent', {
      type,
      touchPoints: type === 'touchEnd' ? [] : [{ x, y }],
    });
  return {
    /** Holds a finger on a point for a while, then lifts it. */
    press: async (x: number, y: number, ms: number) => {
      await touch('touchStart', x, y);
      await page.waitForTimeout(ms);
      await touch('touchEnd', x, y);
    },
    /** Drags a finger left by some pixels, in steps, then lifts it. */
    swipeLeft: async (x: number, y: number, by: number) => {
      await touch('touchStart', x, y);
      for (let step = 1; step <= 6; step++) await touch('touchMove', x - (by * step) / 6, y);
      await touch('touchEnd', x - by, y);
    },
  };
}

/** The middle of a row's text, where a finger lands on it. */
async function centerOf(page: Page, at: number) {
  const box = (await page.getByRole('option').nth(at).boundingBox())!;
  return { x: box.x + box.width / 2, y: box.y + box.height / 2, width: box.width };
}

/** Waits until a check holds, or fails once `ms` have passed without it. */
async function until(check: () => Promise<boolean>, ms: number) {
  const by = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > by) throw new Error(`Still not so after ${ms} ms.`);
    await new Promise((done) => setTimeout(done, 25));
  }
}

/**
 * Holds the asks this browser makes of its Mailroom that `which` picks until released, so what it
 * shows meanwhile comes only from what it already had. The release lets them through, then stops
 * holding.
 */
async function hold(page: Page, which: (request: Request) => boolean) {
  let release = () => {};
  const released = new Promise<void>((done) => (release = done));
  const held: Promise<void>[] = [];
  const holding = (route: Route) => {
    if (!which(route.request())) return route.fallback();
    const through = released.then(() =>
      // An ask the app gave up on meanwhile, as a superseded refetch is, is already handled.
      route.continue().catch((error: unknown) => {
        if (!String(error).includes('already handled')) throw error;
      }),
    );
    held.push(through);
    return through;
  };
  await page.route('**/_serverFn/**', holding);
  return async () => {
    release();
    await Promise.all(held);
    await page.unroute('**/_serverFn/**', holding);
  };
}

/**
 * Waits until the reader shows `count` messages open, each with its body: HTML in its frame, or
 * plain text, and neither still opening nor failed.
 */
async function bodiesShown(page: Page, count: number) {
  await page.waitForFunction(
    (count) => {
      const sheets = [...document.querySelectorAll('section[aria-label="Reader"] article')];
      return (
        sheets.length === count &&
        sheets.every(
          (sheet) =>
            !sheet.querySelector('[role="alert"]') &&
            !sheet.textContent?.includes('Opening…') &&
            [...sheet.querySelectorAll('iframe')].every(
              (frame) => frame.style.visibility === 'visible',
            ),
        )
      );
    },
    count,
    { timeout: ELSEWHERE_MS },
  );
}

/** Waits until the reader shows `count` messages' HTML, each in its frame. */
async function framesShown(page: Page, count: number) {
  await page.waitForFunction(
    (count) =>
      [
        ...document.querySelectorAll<HTMLIFrameElement>('section[aria-label="Reader"] iframe'),
      ].filter((frame) => frame.style.visibility === 'visible').length === count,
    count,
    { timeout: ELSEWHERE_MS },
  );
}

/** The subject the reader shows, once it shows the selected conversation. */
async function shownSubject(page: Page): Promise<string> {
  const shown = await page.waitForFunction(() => {
    const title = document.querySelector('section[aria-label="Reader"] h1')?.textContent;
    const selected = document.querySelector('[role="option"][aria-selected="true"]');
    return title && selected?.textContent?.includes(title) ? title : undefined;
  });
  return (await shown.jsonValue()) as string;
}

const row = (page: Page, subject: RegExp) => page.getByRole('option').filter({ hasText: subject });
/** The row at a place in the list, counting from 1. */
const at = (page: Page, place: number) => page.locator(`[role="option"][aria-posinset="${place}"]`);
/**
 * A row's text, less its read mark. The demo repeats stories, even within the rows on screen, but
 * never two alike in a row, so a row is known by its place and its text.
 */
const textAt = async (page: Page, place: number) =>
  (await at(page, place).textContent())?.replace('Unread', '');
const bar = (page: Page) => page.getByRole('toolbar', { name: 'Conversation' });
const reader = (page: Page) => page.locator('section[aria-label="Reader"]');
/** The toast's Undo. Its name is exact, since a folded message's preview can mention undoing. */
const undoButton = (page: Page) => page.getByRole('button', { name: 'Undo', exact: true });

/**
 * Clicks one of the reader's actions and says how many milliseconds pass until the list, in a
 * painted frame, no longer holds the conversation.
 */
function msUntilGone(page: Page, action: string, subject: string): Promise<number> {
  return page.evaluate(
    ([action, subject]) =>
      new Promise<number>((resolve) => {
        const button = document.querySelector<HTMLElement>(
          `section[aria-label="Reader"] [role="toolbar"] button[aria-label="${action}"]`,
        )!;
        const isListed = () =>
          [...document.querySelectorAll('[role="option"]')].some((row) =>
            row.textContent?.includes(subject),
          );
        const start = performance.now();
        button.click();
        const check = () => {
          if (isListed()) requestAnimationFrame(check);
          else resolve(performance.now() - start);
        };
        requestAnimationFrame(check);
      }),
    [action, subject] as const,
  );
}

test('archiving shows at once, reaches another open browser, and Undo brings it back to both', async () => {
  const [here, there] = await Promise.all([inbox(), inbox()]);
  const subject = /Invoice for October/;
  // The bar's controls stay as they were drawn for the conversation above, which the reader has
  // prepared the next one beside, and act on the one J opens.
  const place = Number(await row(here, subject).getAttribute('aria-posinset'));
  const above = await textAt(here, place - 1);
  await at(here, place - 1).click();
  await shownSubject(here);
  await here.waitForTimeout(1_500);
  await here.keyboard.press('j');
  await expect(shownSubject(here)).resolves.toBe('Invoice for October');
  await bar(here).getByRole('button', { name: 'Archive' }).waitFor();

  const release = await slowCommands(here);
  expect(await msUntilGone(here, 'Archive', 'Invoice for October')).toBeLessThan(50);
  await release();
  await expect(textAt(here, place - 1)).resolves.toBe(above);
  await row(there, subject).waitFor({ state: 'detached', timeout: ELSEWHERE_MS });

  await undoButton(here).click();
  await row(here, subject).waitFor({ timeout: 1_000 });
  await row(there, subject).waitFor({ timeout: ELSEWHERE_MS });
}, 30_000);

test('the frame that shows a conversation archived from the reader keeps its place, its moves and its actions', async () => {
  const page = await inbox();
  await at(page, 3).click();
  const archived = await shownSubject(page);
  const third = await textAt(page, 3);
  await bar(page).getByRole('button', { name: 'Archive' }).waitFor();
  // Every state of the reader's bar, as each change to it lands, from the click until the reader
  // shows the next conversation. Until a row is selected again, it is what the click's frame shows.
  const states = await page.evaluate(
    (archived) =>
      new Promise<
        { title: string; place?: string; previous?: boolean; archive: boolean; moved: boolean }[]
      >((resolve) => {
        const reader = document.querySelector('section[aria-label="Reader"]')!;
        const look = () => {
          const toolbar = reader.querySelector('[role="toolbar"][aria-label="Conversation"]');
          const previous = toolbar?.querySelector('button[aria-label="Previous conversation"]');
          return {
            title: reader.querySelector('h1')?.textContent ?? '',
            place: [...(toolbar?.querySelectorAll('span') ?? [])]
              .map(({ textContent }) => textContent ?? '')
              .find((text) => /^\d+ of \d+\+?$/.test(text)),
            previous: previous
              ? !previous.hasAttribute('disabled') &&
                previous.getAttribute('aria-disabled') !== 'true'
              : undefined,
            archive: Boolean(toolbar?.querySelector('button[aria-label="Archive"]')),
            moved: Boolean(document.querySelector('[role="option"][aria-selected="true"]')),
          };
        };
        const seen: ReturnType<typeof look>[] = [];
        const watching = new MutationObserver(() => {
          seen.push(look());
          if (seen.at(-1)!.title !== archived) {
            watching.disconnect();
            resolve(seen);
          }
        });
        watching.observe(reader, {
          subtree: true,
          childList: true,
          attributes: true,
          characterData: true,
        });
        reader.querySelector<HTMLElement>('[role="toolbar"] button[aria-label="Archive"]')!.click();
      }),
    archived,
  );
  const shownGone = states.filter(({ moved }) => !moved);
  expect(shownGone.length).toBeGreaterThan(0);
  for (const { title, place, previous, archive } of shownGone) {
    expect(title).toBe(archived);
    expect(place).toMatch(/^3 of /);
    expect(previous).toBe(true);
    expect(archive).toBe(true);
  }

  // The other tests here share the member's mail.
  await undoButton(page).click();
  await page.waitForFunction(
    (third) =>
      document
        .querySelector('[role="option"][aria-posinset="3"]')
        ?.textContent?.replace('Unread', '') === third,
    third,
  );
}, 30_000);

test('a flag and a read mark show at once and in the other browser, and Undo takes them back', async () => {
  const [here, there] = await Promise.all([inbox(), inbox()]);
  const subject = /Lunch Thursday/;
  const flagged = (page: Page) => row(page, subject).getByRole('img', { name: 'Flagged' });
  await row(here, subject).click();

  const release = await slowCommands(here);
  await bar(here).getByRole('button', { name: 'Flag', exact: true }).click();
  await flagged(here).waitFor({ timeout: 500 });
  await release();
  await flagged(there).waitFor({ timeout: ELSEWHERE_MS });
  await undoButton(here).click();
  await flagged(here).waitFor({ state: 'detached', timeout: 1_000 });
  await flagged(there).waitFor({ state: 'detached', timeout: ELSEWHERE_MS });

  const unread = (page: Page) => row(page, subject).getByText('Unread', { exact: true });
  await bar(here).getByRole('button', { name: 'More' }).click();
  await here.getByRole('menuitem', { name: 'Mark unread' }).click();
  await unread(here).waitFor({ state: 'attached', timeout: 1_000 });
  await unread(there).waitFor({ state: 'attached', timeout: ELSEWHERE_MS });
}, 30_000);

test('opening a conversation marks it read, here and in the other browser', async () => {
  const [here, there] = await Promise.all([inbox(), inbox()]);
  const subject = /Trip photos/;
  const unread = (page: Page) => row(page, subject).getByText('Unread', { exact: true });
  await unread(here).waitFor({ state: 'attached' });

  await row(here, subject).click();
  await unread(here).waitFor({ state: 'detached', timeout: 1_000 });
  await unread(there).waitFor({ state: 'detached', timeout: ELSEWHERE_MS });
}, 30_000);

test('a selection made with Cmd and Shift is archived together, and Undo brings it all back', async () => {
  const [here, there] = await Promise.all([inbox(), inbox()]);
  const options = here.getByRole('option');
  // A row is known by its subject and preview, which opening it to read doesn't change.
  const lines = (at: number) =>
    Promise.all(
      [2, 3].map((line) =>
        options
          .nth(at)
          .locator(`:scope > span:nth-child(2) > span:nth-child(${line})`)
          .textContent(),
      ),
    );
  const picked = await Promise.all([4, 5, 6].map(lines));
  const listed = (page: Page, [subject, preview]: (string | null)[]) =>
    page
      .getByRole('option')
      .filter({ hasText: subject ?? '' })
      .filter({ hasText: preview ?? '' });
  expect(await Promise.all(picked.map((text) => listed(here, text).count()))).toEqual([1, 1, 1]);
  await options.nth(4).click();
  await options.nth(6).click({ modifiers: ['Shift'] });
  await options.nth(5).click({ modifiers: ['ControlOrMeta'] });
  await here.getByRole('heading', { name: '2 conversations selected' }).waitFor();
  await options.nth(5).click({ modifiers: ['ControlOrMeta'] });
  await here.getByRole('heading', { name: '3 conversations selected' }).waitFor();

  const selection = here.getByRole('toolbar', { name: 'Selected conversations' });
  await selection.getByRole('button', { name: 'Archive' }).click();
  for (const text of picked) {
    await listed(here, text).waitFor({ state: 'detached', timeout: 1_000 });
    await listed(there, text).waitFor({ state: 'detached', timeout: ELSEWHERE_MS });
  }
  await undoButton(here).click();
  for (const text of picked) await listed(there, text).waitFor({ timeout: ELSEWHERE_MS });
}, 30_000);

test('on a phone, a long press starts picking, a tap adds, and the island acts on what was picked', async () => {
  const here = await inbox(PHONE);
  const hand = await finger(here);
  const options = here.getByRole('option');
  const picked = await Promise.all([1, 2].map((at) => options.nth(at).textContent()));
  const first = await centerOf(here, 1);
  await hand.press(first.x, first.y, 700);
  const second = await centerOf(here, 2);
  await hand.press(second.x, second.y, 40);

  const island = here.getByRole('toolbar', { name: 'Picked conversations' });
  await expect(island.textContent()).resolves.toContain('2');
  // Picking keeps the list on screen rather than opening a conversation.
  await expect(options.nth(1).getAttribute('aria-selected')).resolves.toBe('true');
  await expect(options.nth(2).getAttribute('aria-selected')).resolves.toBe('true');

  await island.getByRole('button', { name: 'Archive' }).click();
  for (const text of picked) {
    await options.filter({ hasText: text ?? '' }).waitFor({ state: 'detached', timeout: 1_000 });
  }
  // With nothing picked, the island offers the folders again.
  await here.getByRole('button', { name: 'Folders', exact: true }).waitFor();
}, 30_000);

test('on a phone, a row swiped far enough left is archived, and a short swipe slides back', async () => {
  const here = await inbox(PHONE);
  const hand = await finger(here);
  const options = here.getByRole('option');

  const short = await options.nth(1).textContent();
  const one = await centerOf(here, 1);
  await hand.swipeLeft(one.x, one.y, one.width * 0.2);
  await here.waitForTimeout(400);
  await expect(options.nth(1).textContent()).resolves.toBe(short);
  // The short swipe neither archived nor opened the conversation.
  await expect(options.nth(1).getAttribute('aria-selected')).resolves.toBe('false');

  const far = await options.nth(2).textContent();
  const two = await centerOf(here, 2);
  await hand.swipeLeft(two.x, two.y, two.width * 0.6);
  await options.filter({ hasText: far ?? '' }).waitFor({ state: 'detached', timeout: 1_000 });
  await undoButton(here).click();
  await options.filter({ hasText: far ?? '' }).waitFor({ timeout: ELSEWHERE_MS });
}, 30_000);

test('keys run the registry’s commands: from the list, from inside a message, and ? lists them', async () => {
  const here = await inbox();
  const options = here.getByRole('option');
  const selected = here.locator('[role="option"][aria-selected="true"]');
  await options.nth(1).click();
  const place = () => selected.getAttribute('aria-posinset');
  await expect(place()).resolves.toBe('2');

  await here.keyboard.press('j');
  await expect(place()).resolves.toBe('3');
  await here.keyboard.press('k');
  await expect(place()).resolves.toBe('2');

  // E archives the open conversation, and Z puts it back.
  const archived = options.filter({ hasText: await shownSubject(here) });
  await here.keyboard.press('e');
  await archived.waitFor({ state: 'detached', timeout: 1_000 });
  await undoButton(here).waitFor();
  await here.keyboard.press('z');
  await archived.waitFor({ timeout: ELSEWHERE_MS });

  // After a click inside a message, focus is in its frame, and E still archives. Every message in
  // Toy Box is HTML, so it has a frame.
  await here
    .getByRole('region', { name: 'Personal' })
    .getByRole('button', { name: /^Toy Box/ })
    .click();
  await options.first().click();
  const framed = options.filter({ hasText: await shownSubject(here) });
  await framesShown(here, 1);
  await reader(here).locator('iframe').last().contentFrame().locator('body').click();
  await here.keyboard.press('e');
  await framed.waitFor({ state: 'detached', timeout: 1_000 });

  await here.keyboard.press('?');
  const sheet = here.getByRole('dialog');
  await sheet.getByRole('heading', { name: 'Keyboard shortcuts' }).waitFor();
  await expect(sheet.getByText('Archive', { exact: true }).isVisible()).resolves.toBe(true);
}, 30_000);

test('straight after Z, a conversation opens with its messages, under the refs Undo gave them', async () => {
  const here = await inbox();
  const sheets = reader(here).locator('article');
  const folded = reader(here).locator('h1 ~ button').filter({ hasNotText: 'Go on writing' });
  const failed: string[] = [];
  here.on('response', (response) => {
    if (response.url().includes('%22body%22') && !response.ok()) failed.push(response.url());
  });
  // The first conversation on screen with an earlier message, which lies folded.
  let place = 1;
  for (; (await folded.count()) === 0; place += 1) {
    if (place > 10) throw new Error('No conversation on screen has an earlier message.');
    await at(here, place).click();
    await shownSubject(here);
  }
  place -= 1;
  const [conversation, below] = [await textAt(here, place), await textAt(here, place + 1)];
  await bodiesShown(here, 1);

  // The browser hears of the moves only from the Mailroom's answers to its own commands.
  const refetches = await hold(here, (request) => request.url().includes('%22conversation%22'));
  await here.keyboard.press('e');
  await until(async () => (await textAt(here, place)) === below, 1_000);
  await undoButton(here).waitFor();
  // Undo is held, so the conversation opens while its messages are still in Archive.
  const commands = await hold(here, (request) => request.method() === 'POST');
  await here.keyboard.press('z');
  await until(async () => (await textAt(here, place)) === conversation, 1_000);
  await at(here, place).click();
  await bodiesShown(here, 1);
  const before = await sheets.elementHandle();
  await folded.first().click();
  await bodiesShown(here, 2);

  // Back in the Inbox, each message has a new ref, and both stay open under it.
  await commands();
  await before.waitForElementState('hidden', { timeout: ELSEWHERE_MS });
  await bodiesShown(here, 2);
  await refetches();
  expect(failed).toEqual([]);
}, 30_000);

test('folders are created, renamed and deleted, and a move to one deleted elsewhere returns with the reason', async () => {
  const [here, there] = await Promise.all([inbox(), inbox()]);
  const work = (page: Page) => page.getByRole('region', { name: 'Work' });
  const folderRow = (page: Page, name: string) =>
    work(page).getByRole('button', { name: new RegExp(`^${name}`) });

  await here.getByRole('button', { name: 'More for Work' }).click();
  await here.getByRole('menuitem', { name: 'New folder in Work' }).click();
  await here.getByLabel('Name of the new folder in Work').fill('Trips');
  await here.keyboard.press('Enter');
  await folderRow(here, 'Trips').waitFor({ timeout: ELSEWHERE_MS });
  await folderRow(there, 'Trips').waitFor({ timeout: ELSEWHERE_MS });

  await folderRow(here, 'Trips').click();
  await here.getByRole('button', { name: 'Folder', exact: true }).click();
  await here.getByRole('menuitem', { name: 'Rename Trips' }).click();
  await here.getByLabel('New name for Trips').fill('Journeys');
  await here.keyboard.press('Enter');
  await folderRow(here, 'Journeys').waitFor({ timeout: ELSEWHERE_MS });
  await folderRow(there, 'Journeys').waitFor({ timeout: ELSEWHERE_MS });

  // This browser stops hearing about folders, so it still offers Journeys after it's gone.
  const stale = (route: Route) =>
    route.request().url().includes('%22folders%22') ? route.abort() : route.fallback();
  await here.route('**/_serverFn/**', stale);
  await folderRow(here, 'Inbox').click();
  await at(here, 1).click();
  const [moving, below] = [await textAt(here, 1), await textAt(here, 2)];

  await folderRow(there, 'Journeys').click();
  await there.getByRole('button', { name: 'Folder', exact: true }).click();
  await there.getByRole('menuitem', { name: 'Delete Journeys' }).click();
  await there.getByRole('alertdialog').getByRole('button', { name: 'Delete' }).click();
  await folderRow(there, 'Journeys').waitFor({ state: 'detached', timeout: ELSEWHERE_MS });

  await bar(here).getByRole('button', { name: 'Move to' }).click();
  // The command is held a moment, so the row is seen gone before the refusal brings it back.
  const release = await slowCommands(here);
  await here.getByRole('menuitem', { name: 'Journeys' }).click();
  await until(async () => (await textAt(here, 1)) === below, 1_000);
  await release();
  // The server refuses, so the conversation comes back and a toast says why.
  await until(async () => (await textAt(here, 1)) === moving, ELSEWHERE_MS);
  // The toast and its announcement both say it.
  const refusal = here.getByText(/Couldn't move to Journeys\. .*Journeys/).first();
  await refusal.waitFor({ timeout: ELSEWHERE_MS });
  await expect(refusal.textContent()).resolves.toContain('There is no folder "Journeys"');
  await here.unroute('**/_serverFn/**', stale);
}, 60_000);
