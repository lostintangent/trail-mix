import { afterEach, expect } from 'bun:test';
import type { BrowserContextOptions, Page } from 'playwright';
import { suite } from './suite.ts';

/**
 * The address, end to end: the built app on workerd, on a member of its own. The address names the
 * view, the search and the open conversation, so a reload or another browser opens the same place,
 * Back and Forward step between views, and moving by key adds no history. Choosing a view opens its
 * newest conversation on a desktop, which is read only once it has stayed open.
 */

const DESKTOP = { viewport: { width: 1440, height: 900 } };
const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true };

const app = suite({ vars: { DEV_MEMBER: `address-${Date.now()}@trailmix.test` } });
const { test } = app;

/** Every error a page threw during a test, which fails it. */
const errors: string[] = [];
afterEach(() => {
  expect(errors.splice(0)).toEqual([]);
});

async function open(options: BrowserContextOptions, path = '/'): Promise<Page> {
  const page = await (await app.context(options)).newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(new URL(path, app.url).href);
  await page.getByRole('option').first().waitFor({ timeout: 30_000 });
  return page;
}

const heading = (page: Page) =>
  page.getByRole('heading', { level: 2 }).filter({ hasNotText: /^(Personal|Work)$/ });
const subject = (page: Page) => page.locator('section[aria-label="Reader"] h1');
const selectedRow = (page: Page) => page.locator('[role="option"][aria-selected="true"]');
const historyLength = (page: Page) => page.evaluate(() => history.length);
/** The address once the selection has rested and written it. */
const addressNaming = (page: Page, key: string) =>
  page.waitForFunction((key) => new URL(location.href).searchParams.has(key), key);
/** The conversation the address opens. */
const opened = (page: Page) => new URL(page.url()).searchParams.get('open');
/** Notes any frame that shows the list's top row, which a list opening deep never should. */
const watchTop = (page: Page) =>
  page.addInitScript(() => {
    const look = () => {
      const list = document.querySelector('[role="listbox"][aria-multiselectable]');
      const top = list?.querySelector('[role="option"][aria-posinset="1"]');
      if (list && top) {
        const [row, sheet] = [top.getBoundingClientRect(), list.getBoundingClientRect()];
        if (row.bottom > sheet.top && row.top < sheet.bottom)
          Object.assign(window, { sawTop: true });
      }
      requestAnimationFrame(look);
    };
    requestAnimationFrame(look);
  });
const sawTop = (page: Page) => page.evaluate(() => 'sawTop' in window);
/** Opens a row's conversation and waits for the reader to show it. Returns its subject. */
async function openRow(page: Page, row: number) {
  const option = page.getByRole('option').nth(row);
  const listed = (await option.textContent()) ?? '';
  await option.click();
  await page.waitForFunction((listed) => {
    const shown = document.querySelector('section[aria-label="Reader"] h1')?.textContent;
    return Boolean(shown && listed.includes(shown));
  }, listed);
  return subject(page).textContent();
}

test('a folder and its open conversation come back on a reload and in another browser', async () => {
  const page = await open(DESKTOP);
  await page
    .getByRole('region', { name: 'Personal' })
    .getByRole('button', { name: /^Archive/ })
    .click();
  await heading(page).filter({ hasText: 'Archive' }).waitFor();
  // Choosing the folder opened its newest, and the member opens the next.
  await addressNaming(page, 'open');
  const newest = opened(page);
  const shown = await openRow(page, 1);
  await page.waitForFunction((newest) => {
    const open = new URL(location.href).searchParams.get('open');
    return open !== null && open !== newest;
  }, newest);
  const address = page.url();
  expect(new URL(address).searchParams.get('folder')).toBe('Archive');

  for (const again of [page, await (await app.context(DESKTOP)).newPage()]) {
    await (again === page ? again.reload() : again.goto(address));
    await heading(again).filter({ hasText: 'Archive' }).waitFor();
    await expect(subject(again).textContent()).resolves.toBe(shown);
    await expect(selectedRow(again).textContent()).resolves.toContain(shown!.replace(/^Re: /, ''));
  }
}, 60_000);

test('a conversation deep in its list opens at its page, its row in sight, and J moves on from it', async () => {
  const page = await open(DESKTOP);
  await addressNaming(page, 'open');
  const newest = opened(page);
  const list = page.locator('[role="listbox"][aria-multiselectable]');
  // The first sync may still be listing older mail, which lands below the row and lengthens the list.
  await list.evaluate(async (list) => {
    const length = () =>
      Number(list.querySelector('[role="option"]')?.getAttribute('aria-setsize'));
    while (length() <= 100) await new Promise(requestAnimationFrame);
    list.scrollTop = (list.scrollHeight * 66) / length();
  });
  await list.locator('[role="option"][aria-posinset="70"]').click();
  const place = page.getByRole('toolbar', { name: 'Conversation' });
  const at = (row: number) => place.getByText(new RegExp(`^${row} of \\d+$`));
  await at(70).waitFor();
  await page.waitForFunction((newest) => {
    const open = new URL(location.href).searchParams.get('open');
    return open !== null && open !== newest;
  }, newest);
  const deep = page.url();

  // The list waits for the page holding the row, and opens there: no frame shows its top row.
  await watchTop(page);
  await page.reload();
  await at(70).waitFor();
  await expect(selectedRow(page).getAttribute('aria-posinset')).resolves.toBe('70');
  const [row, sheet] = await Promise.all([selectedRow(page).boundingBox(), list.boundingBox()]);
  expect(row!.y).toBeGreaterThanOrEqual(sheet!.y);
  expect(row!.y + row!.height).toBeLessThanOrEqual(sheet!.y + sheet!.height);
  await expect(sawTop(page)).resolves.toBe(false);
  await page.keyboard.press('j');
  await at(71).waitFor();
  await expect(selectedRow(page).getAttribute('aria-posinset')).resolves.toBe('71');

  // A phone opens it on the reader, with its row in sight on the list behind it.
  const phone = await open(PHONE, deep);
  await subject(phone).waitFor();
  await phone.getByRole('button', { name: 'Back', exact: true }).locator('visible=true').click();
  const shown = phone.locator('[role="listbox"][aria-multiselectable]');
  const [again, screen] = await Promise.all([
    shown.locator('[role="option"][aria-posinset="70"]').boundingBox(),
    shown.boundingBox(),
  ]);
  expect(again!.y).toBeGreaterThanOrEqual(screen!.y);
  expect(again!.y + again!.height).toBeLessThanOrEqual(screen!.y + screen!.height);

  // Back before the page holding the row arrives still waits for it, and then shows the row.
  const early = await (await app.context(PHONE)).newPage();
  early.on('pageerror', (error) => errors.push(error.message));
  let release = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  let asked = 0;
  await early.route('**/_serverFn/**', async (route) => {
    if (decodeURIComponent(route.request().url()).includes('"around"')) {
      asked += 1;
      await held;
    }
    await route.fallback();
  });
  await watchTop(early);
  await early.goto(deep);
  await subject(early).waitFor();
  await early.getByRole('button', { name: 'Back', exact: true }).locator('visible=true').click();
  // Meanwhile the list stands as skeleton rows.
  const back = early.locator('[role="listbox"][aria-multiselectable]');
  await early.waitForTimeout(500);
  await expect(back.count()).resolves.toBe(0);
  await expect(sawTop(early)).resolves.toBe(false);
  expect(asked).toBeGreaterThan(0);
  release();
  await early.unrouteAll({ behavior: 'wait' });
  const cameFrom = back.locator('[role="option"][aria-posinset="70"]');
  await cameFrom.waitFor();
  const [came, from] = await Promise.all([cameFrom.boundingBox(), back.boundingBox()]);
  expect(came!.y).toBeGreaterThanOrEqual(from!.y);
  expect(came!.y + came!.height).toBeLessThanOrEqual(from!.y + from!.height);
  await expect(sawTop(early)).resolves.toBe(false);

  // Archiving the conversation it opened moves on to the next, and the list stays where it is.
  await page.reload();
  await selectedRow(page).waitFor();
  const archived = opened(page);
  await list.evaluate((list) => {
    new MutationObserver(() => {
      if (!list.isConnected) Object.assign(window, { listLeft: true });
    }).observe(document.body, { childList: true, subtree: true });
  });
  await page.keyboard.press('e');
  await page.waitForFunction((archived) => {
    const open = new URL(location.href).searchParams.get('open');
    return open !== null && open !== archived;
  }, archived);
  await expect(page.evaluate(() => 'listLeft' in window)).resolves.toBe(false);
  await expect(sawTop(page)).resolves.toBe(false);
}, 60_000);

test('Back and Forward step between views, and moving by key adds no history', async () => {
  const page = await open(DESKTOP);
  const sidebar = page.getByRole('navigation', { name: 'Mailboxes' });
  await page.getByRole('option').nth(0).click();
  await addressNaming(page, 'open');
  const first = new URL(page.url()).searchParams.get('open');
  const before = await historyLength(page);
  for (let press = 0; press < 5; press++) await page.keyboard.press('j');
  // Once the keys rest, the address names the sixth conversation, which the reader shows.
  await page.waitForFunction((first) => {
    const open = new URL(location.href).searchParams.get('open');
    const row = document.querySelector('[role="option"][aria-selected="true"]');
    const shown = document.querySelector('section[aria-label="Reader"] h1')?.textContent;
    return (
      open !== first &&
      row?.getAttribute('aria-posinset') === '6' &&
      Boolean(shown && row.textContent?.includes(shown.replace(/^Re: /, '')))
    );
  }, first);
  expect(await historyLength(page)).toBe(before);

  await sidebar
    .getByRole('button', { name: /^Drafts/ })
    .first()
    .click();
  await heading(page).filter({ hasText: 'Drafts' }).waitFor();
  await sidebar
    .getByRole('button', { name: /^Flagged/ })
    .first()
    .click();
  await heading(page).filter({ hasText: 'Flagged' }).waitFor();
  await page.goBack();
  await heading(page).filter({ hasText: 'Drafts' }).waitFor();
  await page.goBack();
  await heading(page).filter({ hasText: 'Inbox' }).waitFor();
  await page.goForward();
  await heading(page).filter({ hasText: 'Drafts' }).waitFor();

  // A search typed is one step back, however many keys it took, and a reload keeps it.
  await page.getByRole('searchbox', { name: 'Search mail' }).pressSequentially('lunch thu');
  await page.locator('[role="option"] mark').first().waitFor();
  // Once the typing rests, the address holds the whole search.
  await page.waitForFunction(() => new URL(location.href).searchParams.get('q') === 'lunch thu');
  await page.reload();
  await expect(page.getByRole('searchbox', { name: 'Search mail' }).inputValue()).resolves.toBe(
    'lunch thu',
  );
  await page.locator('[role="option"] mark').first().waitFor();
  await page.goBack();
  await heading(page).filter({ hasText: 'Drafts' }).waitFor();

  // A key's move made just before the view changes is in the step Back returns to.
  await sidebar
    .getByRole('button', { name: /^Inbox/ })
    .first()
    .click();
  await heading(page).filter({ hasText: 'Inbox' }).waitFor();
  await page.getByRole('option').nth(0).click();
  await page.keyboard.press('j');
  await sidebar
    .getByRole('button', { name: /^Flagged/ })
    .first()
    .click();
  await heading(page).filter({ hasText: 'Flagged' }).waitFor();
  await page.goBack();
  await heading(page).filter({ hasText: 'Inbox' }).waitFor();
  await expect(selectedRow(page).getAttribute('aria-posinset')).resolves.toBe('2');
}, 60_000);

test('an address whose conversation or folder has gone opens what remains, and says so', async () => {
  const page = await open(DESKTOP);
  await page.getByRole('option').nth(1).click();
  await addressNaming(page, 'open');
  const opened = new URL(page.url()).searchParams.get('open')!;
  const gone = new URL(page.url());
  gone.searchParams.set('in', 'flagged');
  gone.searchParams.set('open', opened.replace(/:[^:]*$/, ':%3Cgone%40example.com%3E'));
  await page.goto(gone.href);
  await heading(page).filter({ hasText: 'Flagged' }).waitFor();
  await page.waitForFunction(() => location.search === '?in=flagged');
  await expect(selectedRow(page).count()).resolves.toBe(0);

  // A folder gone opens the Inbox, which, naming no conversation, opens at its newest.
  await page.goto(new URL('/?account=gone&folder=Nowhere', app.url).href);
  await heading(page).filter({ hasText: 'Inbox' }).waitFor();
  await page.waitForFunction(() => {
    const address = new URL(location.href).searchParams;
    return !address.has('folder') && !address.has('account');
  });
}, 60_000);

test('on a phone, a conversation opens on its own address, Back slides to the list, and a reload opens it again with no slide', async () => {
  const page = await open(PHONE);
  const reader = page.locator('section[aria-label="Reader"]');
  const isShown = () => reader.evaluate((element) => !element.closest('[inert]'));
  const before = await historyLength(page);
  await page.getByRole('option').nth(1).click();
  await subject(page).waitFor();
  await expect(historyLength(page)).resolves.toBe(before + 1);
  const address = page.url();
  await page.goBack();
  await page.waitForFunction(() => location.search === '');
  await expect(isShown()).resolves.toBe(false);

  // From the first frame the reader holds the screen, with no slide to it.
  await page.addInitScript(() => {
    const first: string[] = [];
    Object.assign(window, { firstReader: first });
    new MutationObserver(() => {
      const reader = document.querySelector('section[aria-label="Reader"]');
      if (reader && first.length === 0) first.push(reader.closest('[inert]') ? 'away' : 'shown');
    }).observe(document, { childList: true, subtree: true });
  });
  await page.goto(address);
  await subject(page).waitFor();
  expect(
    await page.evaluate(() => (window as unknown as { firstReader: string[] }).firstReader),
  ).toEqual(['shown']);
  // Back in the app, with nothing pushed in this visit, takes the conversation out of the address.
  await page.getByRole('button', { name: 'Back', exact: true }).locator('visible=true').click();
  await page.waitForFunction(() => location.search === '');
  await expect(isShown()).resolves.toBe(false);
}, 60_000);

test('choosing a view opens its newest, read only once it has stayed open two seconds', async () => {
  const page = await open(DESKTOP);
  const sidebar = page.getByRole('navigation', { name: 'Mailboxes' });
  const choose = (name: RegExp) => sidebar.getByRole('button', { name }).first().click();
  const inbox = sidebar.getByRole('button', { name: /^Inbox/ }).first();
  const unread = async () => Number((await inbox.textContent())?.match(/\d+/)?.[0]);
  const unreadIs = (count: number, timeout: number) =>
    page.waitForFunction(
      (count) => {
        const inbox = [...document.querySelectorAll('nav[aria-label="Mailboxes"] button')].find(
          (button) => button.textContent?.startsWith('Inbox'),
        );
        return Number(inbox?.textContent?.match(/\d+/)?.[0]) === count;
      },
      count,
      { timeout },
    );
  const newestOpen = async (title: string) => {
    await heading(page).filter({ hasText: title }).waitFor();
    await expect(selectedRow(page).getAttribute('aria-posinset')).resolves.toBe('1');
    // The reader shows the row's conversation.
    await page.waitForFunction(() => {
      const row = document.querySelector('[role="option"][aria-selected="true"]')?.textContent;
      const shown = document.querySelector('section[aria-label="Reader"] h1')?.textContent;
      return Boolean(row && shown && row.includes(shown));
    });
    return (await selectedRow(page).textContent()) ?? '';
  };
  // The Inbox's newest starts unread, whatever came before, and is left before it's read again.
  await choose(/^Inbox/);
  await newestOpen('Inbox');
  await page.keyboard.press('Shift+U');
  await selectedRow(page).filter({ hasText: 'Unread' }).waitFor();
  await choose(/^Flagged/);
  await newestOpen('Flagged');
  await page.waitForTimeout(500);
  const before = await unread();
  const steps = await historyLength(page);

  // Passing through the Inbox on the way to Drafts, by the palette, reads nothing.
  await choose(/^Inbox/);
  expect(await newestOpen('Inbox')).toContain('Unread');
  await page.keyboard.press('ControlOrMeta+k');
  await page.keyboard.type('go to drafts');
  await page.keyboard.press('Enter');
  await newestOpen('Drafts');
  await page.waitForTimeout(2_500);
  expect(await unread()).toBe(before);

  // Staying reads it, only after two seconds, and not while the member scrolls the list.
  await choose(/^Inbox/);
  await newestOpen('Inbox');
  await page.locator('[role="listbox"][aria-multiselectable]').evaluate(
    (list) =>
      new Promise<void>((resolve) => {
        const end = performance.now() + 2_600;
        const step = () => {
          list.scrollTop = list.scrollTop > 2_000 ? 0 : list.scrollTop + 40;
          if (performance.now() < end) requestAnimationFrame(step);
          else resolve();
        };
        requestAnimationFrame(step);
      }),
  );
  expect(await unread()).toBe(before);
  await unreadIs(before - 1, 5_000);

  // Opening it yourself reads it at once, well inside the two seconds.
  await page.keyboard.press('Shift+U');
  await unreadIs(before, 5_000);
  await choose(/^Flagged/);
  await newestOpen('Flagged');
  await choose(/^Inbox/);
  await newestOpen('Inbox');
  await page.getByRole('option').first().click();
  await unreadIs(before - 1, 1_000);

  // Typing a search leaves the reader as it was.
  const shown = await subject(page).textContent();
  await page.getByRole('searchbox', { name: 'Search mail' }).fill('lunch');
  await heading(page).filter({ hasText: 'Search' }).waitFor();
  await expect(subject(page).textContent()).resolves.toBe(shown);

  // A view whose list is known draws its newest in the reader in the same frame as its row.
  await page.evaluate(() => {
    const frames: boolean[] = [];
    Object.assign(window, { readerFrames: frames });
    const check = () => {
      const row = document.querySelector('[role="option"][aria-selected="true"]')?.textContent;
      const shown = document.querySelector('section[aria-label="Reader"] h1')?.textContent;
      frames.push(!row || Boolean(shown && row.includes(shown)));
      if (frames.length < 30) requestAnimationFrame(check);
    };
    requestAnimationFrame(check);
  });
  // Each choice is one step, whose newest is written in place, and the search gives way to the
  // view chosen from it. Back returns to each view with what it had open.
  await choose(/^Flagged/);
  await newestOpen('Flagged');
  await page.waitForFunction(
    () => (window as unknown as { readerFrames: boolean[] }).readerFrames.length >= 30,
  );
  expect(
    await page.evaluate(() => (window as unknown as { readerFrames: boolean[] }).readerFrames),
  ).not.toContain(false);
  await expect(historyLength(page)).resolves.toBe(steps + 6);
  await page.goBack();
  await newestOpen('Inbox');
  await page.goBack();
  await newestOpen('Flagged');
}, 60_000);

test('an empty view opens on the empty reader, and on a phone a view opens on its list', async () => {
  const page = await open(DESKTOP);
  await page.getByRole('button', { name: 'More for Work' }).click();
  await page.getByRole('menuitem', { name: 'New folder in Work' }).click();
  const field = page.getByRole('textbox', { name: 'Name of the new folder in Work' });
  await field.fill('Empty');
  await field.press('Enter');
  await page
    .getByRole('region', { name: 'Work' })
    .getByRole('button', { name: /^Empty/ })
    .click();
  await heading(page).filter({ hasText: 'Empty' }).waitFor();
  await page
    .locator('section[aria-label="Reader"]')
    .getByText('No conversation open')
    .first()
    .waitFor();
  await expect(selectedRow(page).count()).resolves.toBe(0);

  const phone = await open(PHONE);
  await page.close();
  await phone.getByRole('button', { name: 'Folders', exact: true }).click();
  await phone
    .getByRole('navigation', { name: 'Mailboxes' })
    .getByRole('button', { name: /^Drafts/ })
    .first()
    .click();
  await heading(phone).filter({ hasText: 'Drafts' }).waitFor();
  await phone.getByRole('option').first().waitFor();
  await expect(selectedRow(phone).count()).resolves.toBe(0);
  await expect(
    phone.locator('section[aria-label="Reader"]').evaluate((reader) => !reader.closest('[inert]')),
  ).resolves.toBe(false);
}, 60_000);

test('the member’s own choice wins over the view’s newest, however late its list comes', async () => {
  const page = await open(DESKTOP);
  const sidebar = page.getByRole('navigation', { name: 'Mailboxes' });
  /** Holds the view's first page until the returned function lets it through. */
  const hold = async (view: string) => {
    let release = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    await page.route('**/_serverFn/**', async (route) => {
      const asked = decodeURIComponent(route.request().url());
      if (asked.includes('"conversations"') && asked.includes(view)) await held;
      await route.fallback();
    });
    return async () => {
      release();
      await page.unrouteAll({ behavior: 'wait' });
    };
  };

  // A new message begun while Drafts' list is on its way stays open once the list comes.
  let release = await hold('drafts');
  await sidebar
    .getByRole('button', { name: /^Drafts/ })
    .first()
    .click();
  await page.keyboard.press('c');
  const composer = page.locator('section[aria-label="New message"]');
  await composer.waitFor();
  await release();
  await page.getByRole('option').first().waitFor();
  await page.waitForTimeout(300);
  await expect(composer.count()).resolves.toBe(1);
  await expect(selectedRow(page).count()).resolves.toBe(0);
  await page.keyboard.press('Escape');
  await composer.waitFor({ state: 'detached' });

  // A row picked the moment the folder's rows arrive is the one that opens.
  release = await hold('Archive');
  await page
    .getByRole('region', { name: 'Personal' })
    .getByRole('button', { name: /^Archive/ })
    .click();
  await page.evaluate(() =>
    new MutationObserver((_, watching) => {
      const second = document.querySelectorAll<HTMLElement>('[role="option"]')[1];
      if (!second) return;
      watching.disconnect();
      second.click();
    }).observe(document.body, { subtree: true, childList: true }),
  );
  await release();
  await heading(page).filter({ hasText: 'Archive' }).waitFor();
  await page.waitForFunction(() => {
    const row = document.querySelector('[role="option"][aria-selected="true"]');
    const shown = document.querySelector('section[aria-label="Reader"] h1')?.textContent;
    return (
      row?.getAttribute('aria-posinset') === '2' &&
      Boolean(shown && row.textContent?.includes(shown))
    );
  });
  await page.waitForTimeout(500);
  await expect(selectedRow(page).getAttribute('aria-posinset')).resolves.toBe('2');
}, 60_000);
