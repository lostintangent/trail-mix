import { afterEach, beforeAll, expect } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { BrowserContextOptions, Locator, Page, Route } from 'playwright';
import { bareSubject } from '../../src/features/reader/core/subject.ts';
import { unreadableText } from './contrast.ts';
import { suite } from './suite.ts';
import { mailIsIn } from '../mailIsIn.ts';

/**
 * The reader around a conversation, end to end on the demo mailbox: the folder it lies in, a reply
 * and the source of any one of its messages, and on a phone the marks at the top of the screen and
 * the filing in the island.
 */

const SHOTS = join(import.meta.dir, '../../test-results');
const DESKTOP = { viewport: { width: 1440, height: 900 } };
const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true };

const app = suite({ vars: { DEV_MEMBER: `reader-${Date.now()}@trailmix.test` } });
// A test that fails leaves a screenshot of each page and what it showed, for CI to keep.
const { test } = app;

beforeAll(() => {
  mkdirSync(SHOTS, { recursive: true });
});

/** Every error a page threw during a test, which fails it. */
const errors: string[] = [];
afterEach(() => {
  expect(errors.splice(0)).toEqual([]);
});

async function open(
  options: BrowserContextOptions,
  beforeLoad?: (page: Page) => Promise<unknown>,
): Promise<Page> {
  const page = await (await app.context({ deviceScaleFactor: 2, ...options })).newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  await beforeLoad?.(page);
  await page.goto(app.url);
  await mailIsIn(page);
  return page;
}

const reader = (page: Page) => page.getByRole('region', { name: 'Reader' });
const row = (page: Page, subject: string) =>
  page.getByRole('option').filter({ hasText: subject }).first();
/** Waits for the line under the subject, the account, the folder and how many messages, to say this. */
const says = (page: Page, line: string | RegExp) =>
  reader(page).getByText(line, { exact: true }).waitFor({ timeout: 2_000 });
const folder = (page: Page, account: string, name: string) =>
  page
    .getByRole('region', { name: account })
    .getByRole('button', { name: new RegExp(`^${name}( \\d+)?$`) });

async function readable(page: Page, screen: string) {
  await page.screenshot({ path: join(SHOTS, `reader-${screen}.png`) });
  expect({ screen, unreadable: await unreadableText(page) }).toEqual({ screen, unreadable: [] });
}

test('the line under the subject names the folder the conversation lies in', async () => {
  const page = await open({ ...DESKTOP, colorScheme: 'light' });
  await row(page, 'Workers migration plan').click();
  await says(page, 'Personal · Inbox · 3 messages');
  await readable(page, 'desktop-light');

  // A draft's own line says what it is, so the count is of the mail alone.
  await row(page, 'Lunch Thursday?').click();
  await reader(page)
    .getByRole('button', { name: /^Draft/ })
    .waitFor();
  await says(page, 'Personal · Inbox · 1 message');

  // Opened from Sent, where the member's own reply is, it still lies in the Inbox.
  await folder(page, 'Personal', 'Sent').click();
  await row(page, 'Workers migration plan').click();
  await says(page, 'Personal · Inbox · 3 messages');

  await folder(page, 'Personal', 'Archive').click();
  await page.getByRole('option').first().click();
  await says(page, /^Personal · Archive · \d+ messages?$/);
}, 30_000);

test('each message answers and shows the source of its own, and the palette the newest', async () => {
  const page = await open({ ...DESKTOP, colorScheme: 'dark' });
  await row(page, 'Q4 planning').click();
  const newest = reader(page).getByRole('article');
  const newestName = (await newest.getAttribute('aria-label'))!.replace('Message from ', '');
  // The reader's bar files and marks the conversation, and each message holds its own Reply.
  const bar = page.getByRole('toolbar', { name: 'Conversation' });
  await bar.getByRole('button', { name: 'Archive' }).waitFor();
  await expect(bar.getByRole('button', { name: /^Reply/ }).count()).resolves.toBe(0);
  const senders = await reader(page).locator('button strong').allTextContents();
  const earlierName = senders.find((name) => ![newestName, 'You', 'Draft'].includes(name))!;

  // R answers the newest message, and the arrow on an earlier one answers that one.
  const to = page.getByRole('region', { name: 'Reply' }).getByRole('combobox', { name: 'To' });
  const answered = async () => {
    const value = await to.inputValue();
    await page.keyboard.press('Escape');
    await to.waitFor({ state: 'detached' });
    return value;
  };
  await page.keyboard.press('r');
  const newestTo = await answered();
  expect(newestTo).toContain(newestName);
  await reader(page)
    .getByRole('button')
    .filter({ has: page.locator('strong', { hasText: earlierName }) })
    .first()
    .click();
  const earlier = reader(page).getByRole('article', { name: `Message from ${earlierName}` });
  await earlier.getByRole('button', { name: 'Reply', exact: true }).click();
  const earlierTo = await answered();
  expect(earlierTo).toContain(earlierName);
  // Only the newest message's Reply teaches R, the key that answers it. The earlier message's body
  // arrives after it opens and moves the newest down, which takes a Reply out from under a pointer
  // that reached it first, so the pointer waits for every body and goes to Reply again if it must.
  await bodies(page);
  const tooltip = async (article: typeof earlier) => {
    const reply = article.getByRole('button', { name: 'Reply', exact: true });
    const shown = page.getByRole('tooltip').filter({ hasText: /^Reply/ });
    for (let tries = 1; ; tries++) {
      await reply.hover();
      try {
        await shown.waitFor({ timeout: 3_000 });
        break;
      } catch (error) {
        if (tries === 3) throw error;
        await page.mouse.move(0, 0);
      }
    }
    const text = await shown.textContent();
    await page.mouse.move(0, 0);
    await shown.waitFor({ state: 'detached' });
    return text;
  };
  await expect(tooltip(newest.last())).resolves.toBe('Reply (R)');
  await expect(tooltip(earlier)).resolves.toBe('Reply');

  // Its source, from its own menu, is from its own sender.
  const source = page.getByRole('dialog');
  const from = source
    .locator('dt', { hasText: /^From$/ })
    .locator('xpath=following-sibling::dd[1]');
  const address = (to: string) => /<([^>]+)>/.exec(to)?.[1] ?? to;
  await earlier.getByRole('button', { name: 'More for this message' }).click();
  await page.getByRole('menuitem', { name: 'View source' }).click();
  await source.getByText('Loading the source…').waitFor({ state: 'detached' });
  await expect(from.textContent()).resolves.toContain(address(earlierTo));
  await readable(page, 'desktop-dark-source');
  await page.keyboard.press('Escape');
  await source.waitFor({ state: 'detached' });

  // The palette's opens the newest message's.
  await page.keyboard.press('ControlOrMeta+k');
  await page.keyboard.type('view source');
  await page.getByRole('option', { name: 'View source' }).waitFor();
  await page.keyboard.press('Enter');
  await source.getByText('Loading the source…').waitFor({ state: 'detached' });
  await expect(from.textContent()).resolves.toContain(address(newestTo));
}, 30_000);

/** Holds the tooltips' code from a page, which asks for it once its first screen has settled. */
async function holdTooltips(page: Page) {
  const code = /\/assets\/Tooltip-[^/]+\.js$/;
  let release = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route(code, async (route) => {
    await held;
    await route.continue();
  });
  return { asked: page.waitForRequest(code), release: () => release() };
}

test('a button drawn before the tooltips’ code gains its tooltip as it arrives, under a resting pointer or key but never a press or tap', async () => {
  let tooltips!: Awaited<ReturnType<typeof holdTooltips>>;
  const page = await open(DESKTOP, async (page) => (tooltips = await holdTooltips(page)));
  const more = reader(page).getByRole('button', { name: 'More for this message' }).last();
  const tooltip = page.getByRole('tooltip').filter({ hasText: /^More$/ });

  // A pointer resting on it as the code arrives opens its tooltip, which describes it from then on.
  await more.hover();
  await tooltips.asked;
  expect(await page.getByRole('tooltip').count()).toBe(0);
  expect(await more.getAttribute('aria-describedby')).toBeNull();
  tooltips.release();
  await tooltip.waitFor({ timeout: 2_000 });
  const about = await more.and(page.locator('[aria-describedby]')).getAttribute('aria-describedby');
  await expect(page.locator(`[id="${about}"]`).textContent()).resolves.toBe('More');

  // Keyboard focus opens it too, and a menu that takes the tooltip away as it opens gives it back.
  await page.mouse.move(0, 0);
  await tooltip.waitFor({ state: 'detached' });
  await reader(page).getByRole('button', { name: 'Reply', exact: true }).last().focus();
  await page.keyboard.press('Tab');
  await tooltip.waitFor({ timeout: 2_000 });
  await page.keyboard.press('Enter');
  const menu = page.getByRole('menu');
  await menu.waitFor();
  await tooltip.waitFor({ state: 'detached' });
  await page.keyboard.press('Escape');
  await menu.waitFor({ state: 'detached' });
  await more.hover();
  await tooltip.waitFor({ timeout: 2_000 });
  const again = await more.getAttribute('aria-describedby');
  await expect(page.locator(`[id="${again}"]`).textContent()).resolves.toBe('More');

  // A press leaves the button without one, though the pointer rests on it still, and so does a tap,
  // though the tapped button keeps a sticky hover.
  for (const [options, press] of [
    [DESKTOP, (button: Locator) => button.click()],
    [PHONE, (button: Locator) => button.tap()],
  ] as const) {
    const pressed = await open(options, async (page) => (tooltips = await holdTooltips(page)));
    const unread = pressed.getByRole('button', { name: 'Unread only' });
    await press(unread);
    await tooltips.asked;
    tooltips.release();
    await unread.and(pressed.locator('[aria-describedby]')).waitFor();
    expect(await pressed.getByRole('tooltip').count()).toBe(0);
  }
}, 30_000);

test('light paper, chosen in the palette, holds for a sender on every device until turned off', async () => {
  // Two devices of the same member, both in the dark theme, where painted mail is darkened.
  const [first, second] = [
    await open({ ...DESKTOP, colorScheme: 'dark' }),
    await open({ ...DESKTOP, colorScheme: 'dark' }),
  ];
  const control = (page: Page) =>
    reader(page).getByRole('article').last().getByRole('button', { name: 'Light paper' });
  // The paper the newest message's frame lies on, which its document names.
  const shows = (page: Page, paper: 'light' | 'dark') =>
    page.waitForFunction(
      (paper) =>
        [...document.querySelectorAll('iframe')]
          .at(-1)
          ?.contentDocument?.documentElement.getAttribute('data-tm-scheme') === paper,
      paper,
      { timeout: 10_000 },
    );
  for (const page of [first, second]) {
    await row(page, 'Kernel Weekly').click();
    await control(page).waitFor();
    await shows(page, 'dark');
  }
  expect(await control(first).getAttribute('aria-pressed')).toBe('false');

  await first.keyboard.press('ControlOrMeta+k');
  await first.keyboard.type('light paper');
  await first.getByRole('option', { name: /Light paper for this sender/ }).waitFor();
  await first.keyboard.press('Enter');
  await shows(first, 'light');
  expect(await control(first).getAttribute('aria-pressed')).toBe('true');
  await readable(first, 'desktop-dark-light-paper');
  await shows(second, 'light');

  // Turned off on the other device, it darkens on both.
  await control(second).click();
  await shows(second, 'dark');
  await shows(first, 'dark');
  expect(await control(first).getAttribute('aria-pressed')).toBe('false');

  // A sender's plain-text mail goes on light paper too, its whole sheet.
  await row(first, 'Lunch Thursday?').click();
  const plain = reader(first).getByRole('article').last();
  await plain.getByText('Thursday at 12:30').waitFor();
  // Whether the sheet's paper, as the screen draws it, is light.
  const isLight = () =>
    plain.evaluate((sheet) => {
      const context = new OffscreenCanvas(1, 1).getContext('2d', { willReadFrequently: true })!;
      context.fillStyle = getComputedStyle(sheet).backgroundColor;
      context.fillRect(0, 0, 1, 1);
      const [r = 0, g = 0, b = 0] = context.getImageData(0, 0, 1, 1).data;
      return r + g + b > 3 * 128;
    });
  const becomes = async (light: boolean) => {
    for (const start = Date.now(); Date.now() - start < 5_000; await first.waitForTimeout(20)) {
      if ((await isLight()) === light) return true;
    }
    return false;
  };
  expect(await isLight()).toBe(false);
  await control(first).click();
  expect(await becomes(true)).toBe(true);
  await control(first).click();
  expect(await becomes(false)).toBe(true);

  // The member's own mail offers none: light paper is a choice about someone else.
  await row(first, 'Q4 planning').click();
  await reader(first)
    .getByRole('button')
    .filter({ has: first.locator('strong', { hasText: /^You$/ }) })
    .first()
    .click();
  // The line unfolded is the first sheet, the others still lines above and below it.
  const own = reader(first).getByRole('article').first();
  await own.getByRole('button', { name: 'Reply', exact: true }).waitFor();
  expect(await own.getByRole('button', { name: 'Light paper' }).count()).toBe(0);
  expect(await control(first).count()).toBe(1);
}, 60_000);

test('verified list mail offers to unsubscribe in one click, and says whether the sender took it', async () => {
  const page = await open({ ...DESKTOP, colorScheme: 'light' });
  const sheet = reader(page).getByRole('article').last();
  const offer = sheet.getByRole('button', { name: 'Unsubscribe', exact: true });
  const said = (words: string) =>
    sheet.getByRole('status').getByText(words, { exact: true }).waitFor();

  // Mail from no list offers none, on its sheet or in the palette.
  await row(page, 'Lunch Thursday?').click();
  await sheet.getByText('Thursday at 12:30').waitFor();
  expect(await offer.count()).toBe(0);
  expect(await offered(page)).toBe(false);

  // The newsletter's sender is verified for its list. While the sender is asked, the sheet says
  // so, and then that it took it, in the button's place, so the mail under it doesn't move. The
  // palette offers it no more.
  await row(page, 'Kernel Weekly').click();
  await offer.waitFor();
  const mail = sheet.locator('iframe');
  const mailTop = async () => (await mail.boundingBox())?.y;
  const before = await mailTop();
  const release = await holdCommands(page);
  await offer.click();
  await said('Unsubscribing…');
  expect(await mailTop()).toBe(before);
  await release();
  await said('Unsubscribed');
  expect(await mailTop()).toBe(before);
  await readable(page, 'desktop-light-unsubscribed');
  expect(await offered(page)).toBe(false);

  // The shop's list server turns its first try away, which the sheet says in its words, and then
  // takes it.
  await folder(page, 'Personal', 'Trash').click();
  await row(page, 'Your order has shipped').click();
  await offer.click();
  await said('Couldn’t unsubscribe. shop.example.com answered 503 Service Unavailable.');
  await readable(page, 'desktop-light-unsubscribe-refused');
  await sheet.getByRole('button', { name: 'Try again' }).click();
  await said('Unsubscribed');

  // The palette's unsubscribes from the list of the conversation open, here on a page that hasn't
  // asked, in the dark theme.
  const dark = await open({ ...DESKTOP, colorScheme: 'dark' });
  await row(dark, 'Kernel Weekly').click();
  const darkSheet = reader(dark).getByRole('article').last();
  await darkSheet.getByRole('button', { name: 'Unsubscribe', exact: true }).waitFor();
  await darkSheet.getByRole('button', { name: 'Show', exact: true }).click();
  await darkSheet.getByText('1 tracker blocked', { exact: true }).waitFor();
  await readable(dark, 'desktop-dark-unsubscribe');
  expect(await offered(dark, { run: true })).toBe(true);
  await darkSheet.getByText('Unsubscribed', { exact: true }).waitFor();
  await readable(dark, 'desktop-dark-unsubscribed');
}, 60_000);

for (const colorScheme of ['light', 'dark'] as const) {
  test(`on a phone, in ${colorScheme}, a newsletter's sheet offers to unsubscribe, and says the sender took it`, async () => {
    const page = await open({ ...PHONE, colorScheme });
    await row(page, 'Kernel Weekly').click();
    const sheet = reader(page).getByRole('article').last();
    await sheet.getByRole('button', { name: 'Unsubscribe', exact: true }).tap();
    await sheet.getByText('Unsubscribed', { exact: true }).waitFor();
    await readable(page, `phone-${colorScheme}-unsubscribed`);
  }, 30_000);
}

/**
 * Whether the palette offers to unsubscribe from the list of the conversation open, and runs it
 * when asked. Once the palette shows, it draws what matches within two frames of the typing.
 */
async function offered(page: Page, { run = false } = {}): Promise<boolean> {
  await page.keyboard.press('ControlOrMeta+k');
  await page.getByRole('listbox', { name: 'Commands' }).waitFor();
  await page.keyboard.type('unsubscribe');
  await page.evaluate(
    () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
  );
  const command = page.getByRole('option', { name: 'Unsubscribe from this list' });
  const isOffered = (await command.count()) === 1;
  if (isOffered && run) {
    await page.keyboard.press('Enter');
  } else {
    // Closes the palette, then leaves the search it began.
    await page.keyboard.press('Escape');
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.press('Backspace');
  }
  return isOffered;
}

/** Holds every command this page sends until released, so what shows before is its own doing. */
async function holdCommands(page: Page): Promise<() => Promise<void>> {
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  const hold = async (route: Route) => {
    if (route.request().method() === 'POST') await released;
    await route.continue().catch(() => {});
  };
  await page.route('**/_serverFn/**', hold);
  return async () => {
    release();
    await page.unroute('**/_serverFn/**', hold);
  };
}

for (const colorScheme of ['light', 'dark'] as const) {
  test(`in ${colorScheme}, the demo newsletter’s images, once shown, are its own pictures, and its open pixel stays blocked`, async () => {
    const page = await open({ ...DESKTOP, colorScheme });
    // Each remote image the page asked the Worker for, by the address it names.
    const asked: { url: string; status: number }[] = [];
    page.on('response', (response) => {
      const url = new URL(response.url());
      if (url.pathname !== '/images') return;
      asked.push({ url: url.searchParams.get('url') ?? '', status: response.status() });
    });
    await row(page, 'Kernel Weekly').click();
    const newest = reader(page).getByRole('article').last();
    await newest.getByText('Images from Kernel Weekly are hidden.').waitFor();
    await newest.getByRole('button', { name: 'Show', exact: true }).click();

    // Every remote image in the newest message's frame comes in as a picture, not a broken box.
    await page.waitForFunction(
      () => {
        const frame = [...document.querySelectorAll('iframe')].at(-1)?.contentDocument;
        const remote = [...(frame?.images ?? [])].filter(
          (image) => new URL(image.src).pathname === '/images',
        );
        return (
          remote.length >= 3 && remote.every((image) => image.complete && image.naturalWidth > 0)
        );
      },
      undefined,
      { timeout: 15_000 },
    );
    expect(asked.some(({ url }) => url.endsWith('/masthead.svg'))).toBe(true);
    expect(asked.filter(({ status }) => status !== 200)).toEqual([]);
    expect(asked.filter(({ url }) => url.includes('/open/'))).toEqual([]);
    await readable(page, `desktop-${colorScheme}-newsletter-images`);
  }, 30_000);
}

for (const colorScheme of ['light', 'dark'] as const) {
  test(`on a phone, in ${colorScheme}, a sheet keeps its time whole, and a new message’s title sits on its buttons’ line`, async () => {
    const page = await open({ ...PHONE, colorScheme });
    await row(page, 'Q4 planning').click();
    const header = reader(page).getByRole('article').last().locator('header');
    await header.locator('time').waitFor();
    // The time is one line, on the recipients' line, however long the recipients are.
    const line = await header.evaluate((element) => {
      const time = element.querySelector('time');
      const to = time?.closest('small')?.firstElementChild;
      return {
        timeLines: time?.getClientRects().length,
        sameLine:
          Math.abs(
            (time?.getBoundingClientRect().top ?? 0) - (to?.getBoundingClientRect().top ?? -1),
          ) < 2,
      };
    });
    expect(line).toEqual({ timeLines: 1, sameLine: true });
    await page.screenshot({ path: join(SHOTS, `reader-phone-${colorScheme}-time.png`) });

    await page.keyboard.press('c');
    const sheet = page.locator('section[aria-label="New message"]');
    await sheet.waitFor();
    // Places are measured from the header's top, since the sheet may still be rising.
    const centers = await sheet.locator('header').evaluate((element) => {
      const middle = (found: Element | null | undefined) => {
        const box = found?.getBoundingClientRect();
        return box
          ? Math.round(box.top + box.height / 2 - element.getBoundingClientRect().top)
          : NaN;
      };
      return {
        title: middle(element.querySelector('h2')),
        close: middle(element.querySelector('button')),
      };
    });
    expect(Math.abs(centers.title - centers.close)).toBeLessThanOrEqual(1);
    // What saving says lies under the title, inside the header, and moves the title nowhere, at
    // its longest. Only its place matters here, so it's written in rather than saved for.
    await sheet.locator('header h2 + [role="status"]').evaluate((said) => {
      said.textContent = 'Couldn’t save. Trying again…';
    });
    const placed = await sheet.locator('header').evaluate((element) => {
      const box = (found: Element | null) => found?.getBoundingClientRect();
      const [header, title, said] = [
        element,
        element.querySelector('h2'),
        element.querySelector('h2 + [role="status"]'),
      ].map(box);
      return {
        under: (said?.top ?? 0) >= (title?.bottom ?? 0) - 1,
        inside: (said?.bottom ?? Infinity) <= (header?.bottom ?? 0),
        titleMiddle: Math.round((title?.top ?? 0) + (title?.height ?? 0) / 2 - (header?.top ?? 0)),
      };
    });
    expect(placed).toEqual({ under: true, inside: true, titleMiddle: centers.title });
    await page.screenshot({ path: join(SHOTS, `composer-phone-${colorScheme}-title.png`) });
  }, 30_000);
}

test('a conversation the Mailroom won’t give says so under its subject, and Try again opens it', async () => {
  const page = await open({ ...DESKTOP, colorScheme: 'light' });
  await page.route('**/_serverFn/**', async (route) => {
    const asked = decodeURIComponent(route.request().url());
    await (asked.includes('"conversation"') ? route.abort() : route.fallback());
  });
  await row(page, 'Trip photos').click();
  // The empty reader would say no conversation is open, though one is chosen.
  await reader(page)
    .getByRole('alert')
    .filter({ hasText: 'This conversation could not be opened.' })
    .waitFor({ timeout: 15_000 });
  expect(await reader(page).locator('h1').textContent()).toBe('Trip photos');
  await page.unrouteAll({ behavior: 'wait' });
  await reader(page).getByRole('button', { name: 'Try again' }).click();
  await says(page, 'Personal · Inbox · 1 message');
}, 30_000);

test('the Outbox’s empty reader asks for a send', async () => {
  const page = await open({ ...DESKTOP, colorScheme: 'light' });
  await page
    .getByRole('button', { name: /^Outbox/ })
    .first()
    .click();
  await reader(page).getByText('Choosing a send opens its conversation here.').waitFor();
});

for (const colorScheme of ['light', 'dark'] as const) {
  test(`on a phone, in ${colorScheme}, the top of the screen marks and the island files`, async () => {
    const page = await open({ ...PHONE, colorScheme });
    // Each scheme marks a conversation of its own, as both share the member's mailbox.
    const subject = colorScheme === 'light' ? 'Workers migration plan' : 'Lunch Thursday?';
    await row(page, subject).click();
    const top = page.getByRole('toolbar', { name: 'Marks' });
    const island = page.getByRole('toolbar', { name: 'Conversation' });
    await top.getByRole('button', { name: 'Flag', exact: true }).waitFor();
    await readable(page, `phone-${colorScheme}`);

    /** Each button's name, from its label or else its word. */
    const names = (toolbar: typeof top) =>
      toolbar
        .getByRole('button')
        .evaluateAll((buttons) =>
          buttons.map((button) => button.getAttribute('aria-label') ?? button.textContent?.trim()),
        );
    await expect(names(top)).resolves.toEqual(['Flag', 'More']);
    await expect(names(island)).resolves.toEqual(['Archive', 'Delete', 'Move to', 'Reply']);
    expect(await reader(page).getByRole('button', { name: 'Back', exact: true }).isVisible()).toBe(
      true,
    );

    await top.getByRole('button', { name: 'Flag', exact: true }).click();
    await top.getByRole('button', { name: 'Unflag', exact: true }).waitFor({ timeout: 1_000 });
    await top.getByRole('button', { name: 'More' }).click();
    await page.getByRole('menuitem', { name: 'Mark unread' }).click();
    await row(page, subject)
      .getByText('Unread', { exact: true })
      .waitFor({ state: 'attached', timeout: 1_000 });
  }, 30_000);
}

for (const [size, options] of Object.entries({ desktop: DESKTOP, phone: PHONE })) {
  for (const colorScheme of ['light', 'dark'] as const) {
    test(`mail on its way shows skeletons where it will lie, and mail that comes quickly shows none, ${size} ${colorScheme}`, async () => {
      // The composer's code is held from the start, before anything could load it ahead.
      let releaseComposer!: () => void;
      const composerCode = new Promise<void>((resolve) => (releaseComposer = resolve));
      const page = await open({ ...options, colorScheme }, (page) =>
        page.route(/\/assets\/Composer-/, async (route) => {
          await composerCode;
          await route.continue().catch(() => {});
        }),
      );
      const shot = (screen: string) =>
        page.screenshot({ path: join(SHOTS, `skeleton-${screen}-${size}-${colorScheme}.png`) });

      // A new message while the composer's code is on its way shows its sheet with lines.
      await page.keyboard.press('c');
      await shown(page, 'section[aria-label="Message"] [role="status"][aria-busy="true"]');
      await shot('composer');
      releaseComposer();
      await page.locator('section[aria-label="New message"]').waitFor();
      await page.keyboard.press('Escape');
      await page.locator('section[aria-label="New message"]').waitFor({ state: 'detached' });
      await watchSkeletons(page);

      // Mail that answers within the skeletons' delay, if not at once: a conversation, an older
      // message, another view.
      const quick = await slowed(page, QUICK_MS);
      await openRow(page, 'Q4 planning');
      await bodies(page);
      await unfold(page);
      await bodies(page);
      await goTo(page, 'Sent');
      await page.getByRole('option').first().waitFor();
      await quick();
      expect({ quick: await skeletonsSeen(page) }).toEqual({ quick: 0 });

      // A view not yet loaded shows rows that the first page lands on exactly.
      const list = await holding(page, 'conversations');
      await goTo(page, 'Archive');
      const rows = await shown(page, '[role="status"][aria-busy="true"] > div');
      await shot('list');
      await list();
      await page.getByRole('option').first().waitFor();
      const first = await boxOf(page, '[role="option"]');
      expect(first).toEqual(rows);

      // A conversation opened while the Mailroom is slow shows its subject in the click's own
      // frame, its sheets as skeletons, and never the empty reader. Its subject stays put.
      const slow = await slowed(page, SLOW_MS);
      const target = page.getByRole('option').nth(4);
      const listed = await target.evaluate((row) => row.lastElementChild?.children[1]?.textContent);
      await watchOpening(page);
      await target.click();
      const opening = await openingSeen(page);
      expect(opening.clicked).toEqual({ subject: bareSubject(listed ?? ''), pending: true });
      await shown(page, 'section[aria-label="Reader"] [role="status"][aria-busy="true"]');
      await shot('reader');
      await reader(page)
        .getByRole('article')
        .first()
        .waitFor({ timeout: SLOW_MS * 3 });
      await slow();
      expect((await openingSeen(page)).empty).toBe(false);
      expect(await boxOf(page, 'section[aria-label="Reader"] h1')).toEqual(opening.subjectBox);

      // An older message's body on its way shows lines on its sheet, and the sheet holds still.
      const body = await holding(page, 'body');
      await openRow(page, 'Workers migration plan');
      await unfold(page);
      const sheet = 'section[aria-label="Reader"] article:first-of-type header';
      await shown(page, 'section[aria-label="Reader"] article [role="status"][aria-busy="true"]');
      const header = await boxOf(page, sheet);
      // Its controls are there from the start, so none arrives with the body to squeeze its line.
      const controls = () =>
        page
          .locator(sheet)
          .getByRole('button')
          .evaluateAll((buttons) => buttons.map((button) => button.getAttribute('aria-label')));
      const waiting = await controls();
      await shot('body');
      await body();
      await bodies(page);
      expect(await boxOf(page, sheet)).toEqual(header);
      expect(await controls()).toEqual(waiting);

      // A draft opened while its words are on their way shows the composer's sheet with lines.
      const words = await holding(page, 'body');
      await goTo(page, 'Drafts');
      await page.getByRole('option').first().click();
      await reader(page)
        .getByRole('button', { name: /^Draft/ })
        .click();
      await shown(page, 'section[aria-label="Message"] [role="status"][aria-busy="true"]');
      await shot('draft');
      expect(await page.getByText('Opening…').count()).toBe(0);
      await words();
      await page
        .getByRole('button', { name: 'Send', exact: true })
        .filter({ visible: true })
        .waitFor();
    }, 60_000);
  }
}

test('an older message’s body is asked for as the pointer rests on its line or it takes the focus', async () => {
  const page = await open({ ...DESKTOP, colorScheme: 'light' });
  await openRow(page, 'Workers migration plan');
  await bodies(page);
  // The conversations either side are prepared while the browser is idle, which this waits out.
  await page.waitForTimeout(1_500);
  const asked: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes(encodeURIComponent('"body"'))) asked.push(request.url());
  });
  const lines = reader(page)
    .locator('button')
    .filter({ has: page.locator('time') });
  const [first, second] = [lines.nth(0), lines.nth(1)];

  // A pointer passing over a line asks for nothing.
  const box = await first.boundingBox();
  await page.mouse.move(box!.x + 20, box!.y + box!.height / 2);
  await page.mouse.move(0, 0);
  await page.waitForTimeout(400);
  expect(asked).toEqual([]);

  // One that rests there asks for its body, and focus asks at once.
  await first.hover();
  await waitUntil(() => asked.length === 1);
  await second.focus();
  await waitUntil(() => asked.length === 2);
}, 30_000);

// The dark theme offers light paper for the conversation open, which must ask for nothing itself.
test('a held key in the dark theme asks for no conversation it passes', async () => {
  const page = await open({ ...DESKTOP, colorScheme: 'dark' });
  await page.getByRole('option').first().click();
  // The first conversations are prepared while the browser is idle, which this waits out.
  await page.waitForTimeout(1_500);
  const asked = new Set<string>();
  page.on('request', (request) => {
    const url = decodeURIComponent(request.url());
    if (url.includes('"conversation"')) asked.add(/"s":"([^"]+::[^"]+)"/.exec(url)?.[1] ?? url);
  });
  // Twelve rows passed at a held key's pace, quicker than a rest. Only a refetch the demo's own
  // mail causes may ask for one, where asking for each row passed would ask for about twelve.
  for (let press = 0; press < 12; press++) {
    await page.keyboard.press('ArrowDown');
    await page.waitForTimeout(30);
  }
  expect(asked.size).toBeLessThanOrEqual(2);
}, 30_000);

test('a conversation is asked for as the pointer rests on its row, and its newest body as the row is pressed', async () => {
  const page = await open({ ...DESKTOP, colorScheme: 'light' });
  await page.getByRole('option').first().waitFor();
  // The first conversations are prepared while the browser is idle, which this waits out.
  await page.waitForTimeout(1_500);
  const asked: string[] = [];
  page.on('request', (request) => {
    const url = decodeURIComponent(request.url());
    if (url.includes('"conversation"')) asked.push('conversation');
    if (url.includes('"body"')) asked.push('body');
  });
  const target = page.getByRole('option').nth(6);

  // A pointer passing over a row asks for nothing.
  const box = await target.boundingBox();
  await page.mouse.move(box!.x + 40, box!.y + box!.height / 2);
  await page.mouse.move(0, 0);
  await page.waitForTimeout(400);
  expect(asked).toEqual([]);

  // One that rests asks for the conversation, and a press for its newest body, before the click.
  await target.hover();
  await waitUntil(() => asked.includes('conversation'));
  expect(asked).not.toContain('body');
  await page.mouse.down();
  await waitUntil(() => asked.includes('body'));
  await page.mouse.up();
}, 30_000);

/** How late a slow Mailroom answers. */
const SLOW_MS = 1_500;

/**
 * Notes what the reader shows in the frame after the next click, and whether it shows its empty
 * state in any frame after that until a message arrives.
 */
async function watchOpening(page: Page) {
  await page.evaluate(() => {
    type Opening = {
      clicked?: { subject: string | null; pending: boolean };
      subjectBox?: { top: number; height: number };
      empty: boolean;
    };
    const seen: Opening = { empty: false };
    (window as unknown as { opening: Opening }).opening = seen;
    const reader = () => document.querySelector('section[aria-label="Reader"]');
    const look = () => {
      if (reader()?.textContent?.includes('No conversation open')) seen.empty = true;
      if (!reader()?.querySelector('article')) requestAnimationFrame(look);
    };
    addEventListener(
      'click',
      () =>
        requestAnimationFrame(() => {
          const subject = reader()?.querySelector('h1');
          const box = subject?.getBoundingClientRect();
          seen.clicked = {
            subject: subject?.textContent ?? null,
            pending: Boolean(reader()?.querySelector('[role="status"][aria-busy="true"]')),
          };
          seen.subjectBox = box && { top: box.top, height: Math.round(box.height) };
          look();
        }),
      { once: true },
    );
  });
}

/** What `watchOpening` saw, once the click's frame has been drawn. */
async function openingSeen(page: Page) {
  await page.waitForFunction(
    () => (window as unknown as { opening: { clicked?: unknown } }).opening.clicked,
  );
  return page.evaluate(
    () =>
      (
        window as unknown as {
          opening: {
            clicked: { subject: string | null; pending: boolean };
            subjectBox?: { top: number; height: number };
            empty: boolean;
          };
        }
      ).opening,
  );
}

/** Under the skeletons' delay, `tm.skeletonDelay`, yet long enough for several frames. */
const QUICK_MS = 150;

/** Answers every query `ms` late, until the returned function puts things back. */
async function slowed(page: Page, ms: number): Promise<() => Promise<void>> {
  const slow = async (route: Route) => {
    if (route.request().method() === 'GET') await new Promise((resolve) => setTimeout(resolve, ms));
    await route.continue().catch(() => {});
  };
  await page.route('**/_serverFn/**', slow);
  return () => page.unroute('**/_serverFn/**', slow);
}

/** Holds every query of this name until released, as a slow Mailroom would. */
async function holding(page: Page, name: string): Promise<() => Promise<void>> {
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  const named = encodeURIComponent(`"${name}"`);
  const hold = async (route: Route) => {
    if (route.request().url().includes(named)) await released;
    await route.continue().catch(() => {});
  };
  await page.route('**/_serverFn/**', hold);
  return async () => {
    release();
    await page.unroute('**/_serverFn/**', hold);
  };
}

/**
 * Notes, every frame from now on, how visible any skeleton is, so a test can tell whether one ever
 * showed, if only for a frame.
 */
async function watchSkeletons(page: Page) {
  await page.evaluate(() => {
    const seen = { most: 0 };
    (window as unknown as { skeletons: typeof seen }).skeletons = seen;
    const look = () => {
      for (const pending of document.querySelectorAll('[role="status"][aria-busy="true"]')) {
        seen.most = Math.max(seen.most, Number(getComputedStyle(pending).opacity));
      }
      requestAnimationFrame(look);
    };
    requestAnimationFrame(look);
  });
}

/** How visible the most visible skeleton was since the page began watching. */
const skeletonsSeen = (page: Page) =>
  page.evaluate(() => (window as unknown as { skeletons: { most: number } }).skeletons.most);

/** Waits until the first element `selector` names is fully shown, and returns where it lies. */
async function shown(page: Page, selector: string) {
  await page.waitForFunction((selector) => {
    const element = document.querySelector(selector);
    const pending = element?.closest('[role="status"]') ?? element;
    return element && pending && Number(getComputedStyle(pending).opacity) === 1;
  }, selector);
  return boxOf(page, selector);
}

/** Where the first element `selector` names lies on the page. */
function boxOf(page: Page, selector: string) {
  return page.evaluate((selector) => {
    const box = document.querySelector(selector)?.getBoundingClientRect();
    return box && { top: box.top, height: Math.round(box.height) };
  }, selector);
}

/** Opens a conversation from the unified Inbox, from the list on a phone. */
async function openRow(page: Page, subject: string) {
  await goTo(page, 'Inbox');
  await row(page, subject).click();
}

/** Opens the first message folded in the open conversation. */
async function unfold(page: Page) {
  await reader(page)
    .locator('button')
    .filter({ has: page.locator('time') })
    .first()
    .click();
}

/** Waits until every open message shows its body. */
async function bodies(page: Page) {
  await page.waitForFunction(() => {
    const sheets = [...document.querySelectorAll('section[aria-label="Reader"] article')];
    return (
      sheets.length > 0 &&
      sheets.every(
        (sheet) =>
          !sheet.querySelector('[aria-busy="true"]') &&
          [...sheet.querySelectorAll('iframe')].every(
            (frame) => frame.style.visibility === 'visible',
          ),
      )
    );
  });
}

/** Goes to a view: one of the unified ones, or one of Personal's folders. On a phone, by its folders. */
async function goTo(page: Page, view: 'Inbox' | 'Sent' | 'Archive' | 'Drafts') {
  const back = reader(page).getByRole('button', { name: 'Back', exact: true });
  if (await reachable(back)) await back.click();
  const button =
    view === 'Inbox'
      ? page.getByRole('button', { name: /^Inbox/ }).first()
      : folder(page, 'Personal', view);
  if (!(await reachable(button))) {
    await page.getByRole('button', { name: 'Folders', exact: true }).click();
  }
  await button.click();
}

/** Whether a control is on screen and can be used. A pane off a phone's screen is inert. */
async function reachable(control: Locator): Promise<boolean> {
  return (await control.isVisible()) && control.evaluate((element) => !element.closest('[inert]'));
}

/** Polls until `isTrue` holds, for a second at most. */
async function waitUntil(isTrue: () => boolean) {
  for (const started = Date.now(); !isTrue();) {
    if (Date.now() - started > 1_000) throw new Error('It never came true');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
