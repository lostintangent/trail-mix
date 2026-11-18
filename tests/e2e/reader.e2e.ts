import { expect } from 'bun:test';
import { join } from 'node:path';
import type { Locator, Page, Request } from 'playwright';
import { REST_MS } from '../../src/features/reader/core/rest.ts';
import { bareSubject } from '../../src/features/reader/core/subject.ts';
import { expectUsable } from './usable.ts';
import { bodiesShown, chipsIn, goTo, hold, reader, slow } from './helpers.ts';
import { RESULTS, SIZES, suite } from './suite.ts';
import { until } from '../until.ts';

/**
 * The reader around a conversation, end to end on the demo mailbox: the folder it lies in, a reply
 * and the source of any one of its messages, and on a phone the marks at the top of the screen and
 * the filing in the island.
 */

const app = suite({ vars: { DEV_MEMBER: `reader-${Date.now()}@trailmix.test` }, scale: 2 });
// A test that fails leaves a screenshot of each page and what it showed, for CI to keep.
const { test, open } = app;

const row = (page: Page, subject: string) =>
  page.getByRole('option').filter({ hasText: subject }).first();
/** Waits for the line under the subject, the account, the folder and how many messages, to say this. */
const says = (page: Page, line: string | RegExp) =>
  reader(page).getByText(line, { exact: true }).waitFor({ timeout: 2_000 });
const folder = (page: Page, account: string, name: string) =>
  page
    .getByRole('region', { name: account })
    .getByRole('button', { name: new RegExp(`^${name}( \\d+)?$`) });

test('the line under the subject names the folder the conversation lies in', async () => {
  const page = await open({ ...SIZES.desktop, colorScheme: 'light' });
  await row(page, 'Workers migration plan').click();
  await says(page, 'Personal · Inbox · 3 messages');
  await expectUsable(page, 'reader-desktop-light');

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
  const page = await open({ ...SIZES.desktop, colorScheme: 'dark' });
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
  const reply = page.getByRole('region', { name: 'Reply' });
  const to = reply.getByRole('combobox', { name: 'To' });
  const answered = async () => {
    await to.waitFor();
    const chips = await chipsIn(reply, 'To');
    await page.keyboard.press('Escape');
    await to.waitFor({ state: 'detached' });
    return chips.join('; ');
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
  await bodiesShown(page);
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
  const address = (to: string) => /[^\s,;]+@[^\s,;]+/.exec(to)?.[0] ?? to;
  await earlier.getByRole('button', { name: 'More for this message' }).click();
  await page.getByRole('menuitem', { name: 'View source' }).click();
  await source.getByText('Loading the source…').waitFor({ state: 'detached' });
  await expect(from.textContent()).resolves.toContain(address(earlierTo));
  await expectUsable(page, 'reader-desktop-dark-source');
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
const holdTooltips = (page: Page) => hold(page, /\/assets\/Tooltip-[^/]+\.js$/);

test('a button drawn before the tooltips’ code gains its tooltip as it arrives, under a resting pointer or key but never a press or tap', async () => {
  let tooltips!: Awaited<ReturnType<typeof holdTooltips>>;
  const page = await open(SIZES.desktop, {
    before: async (page) => (tooltips = await holdTooltips(page)),
  });
  const more = reader(page).getByRole('button', { name: 'More for this message' }).last();
  const tooltip = page.getByRole('tooltip').filter({ hasText: /^More$/ });

  // A pointer resting on it as the code arrives opens its tooltip, which describes it from then on.
  await more.hover();
  await tooltips.requested;
  expect(await page.getByRole('tooltip').count()).toBe(0);
  expect(await more.getAttribute('aria-describedby')).toBeNull();
  await tooltips.release();
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
    [SIZES.desktop, (button: Locator) => button.click()],
    [SIZES.phone, (button: Locator) => button.tap()],
  ] as const) {
    const pressed = await open(options, {
      before: async (page) => (tooltips = await holdTooltips(page)),
    });
    const unread = pressed.getByRole('button', { name: 'Unread only' });
    await press(unread);
    await tooltips.requested;
    await tooltips.release();
    await unread.and(pressed.locator('[aria-describedby]')).waitFor();
    expect(await pressed.getByRole('tooltip').count()).toBe(0);
  }
}, 30_000);

test('light paper, chosen in the palette, holds for a sender on every device until turned off', async () => {
  // Two devices of the same member, both in the dark theme, where painted mail is darkened.
  const [first, second] = [
    await open({ ...SIZES.desktop, colorScheme: 'dark' }),
    await open({ ...SIZES.desktop, colorScheme: 'dark' }),
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
  await expectUsable(first, 'reader-desktop-dark-light-paper');
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
  // Waits for the sheet's paper, as the screen draws it, to be light or not.
  const sheet = await plain.elementHandle();
  const becomes = (light: boolean) =>
    first.waitForFunction(
      ([sheet, light]) => {
        const context = new OffscreenCanvas(1, 1).getContext('2d', { willReadFrequently: true })!;
        context.fillStyle = getComputedStyle(sheet).backgroundColor;
        context.fillRect(0, 0, 1, 1);
        const [r = 0, g = 0, b = 0] = context.getImageData(0, 0, 1, 1).data;
        return r + g + b > 3 * 128 === light;
      },
      [sheet, light] as const,
      { timeout: 5_000 },
    );
  await becomes(false);
  await control(first).click();
  await becomes(true);
  await control(first).click();
  await becomes(false);

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
  const page = await open({ ...SIZES.desktop, colorScheme: 'light' });
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
  const commands = await hold(page, (request) => request.method() === 'POST');
  await offer.click();
  await said('Unsubscribing…');
  expect(await mailTop()).toBe(before);
  await commands.release();
  await said('Unsubscribed');
  expect(await mailTop()).toBe(before);
  await expectUsable(page, 'reader-desktop-light-unsubscribed');
  expect(await offered(page)).toBe(false);

  // The shop's list server turns its first try away, which the sheet says in its words, and then
  // takes it.
  await folder(page, 'Personal', 'Trash').click();
  await row(page, 'Your order has shipped').click();
  await offer.click();
  await said('Couldn’t unsubscribe. shop.example.com answered 503 Service Unavailable.');
  await expectUsable(page, 'reader-desktop-light-unsubscribe-refused');
  await sheet.getByRole('button', { name: 'Try again' }).click();
  await said('Unsubscribed');

  // The palette's unsubscribes from the list of the conversation open, here on a page that hasn't
  // asked, in the dark theme.
  const dark = await open({ ...SIZES.desktop, colorScheme: 'dark' });
  await row(dark, 'Kernel Weekly').click();
  const darkSheet = reader(dark).getByRole('article').last();
  await darkSheet.getByRole('button', { name: 'Unsubscribe', exact: true }).waitFor();
  await darkSheet.getByRole('button', { name: 'Show', exact: true }).click();
  await darkSheet.getByText('1 tracker blocked', { exact: true }).waitFor();
  await expectUsable(dark, 'reader-desktop-dark-unsubscribe');
  expect(await offered(dark, { run: true })).toBe(true);
  await darkSheet.getByText('Unsubscribed', { exact: true }).waitFor();
  await expectUsable(dark, 'reader-desktop-dark-unsubscribed');
}, 60_000);

test("on a phone, a newsletter's sheet offers to unsubscribe, and says the sender took it", async () => {
  const page = await open({ ...SIZES.phone, colorScheme: 'light' });
  await row(page, 'Kernel Weekly').click();
  const sheet = reader(page).getByRole('article').last();
  await sheet.getByRole('button', { name: 'Unsubscribe', exact: true }).tap();
  await sheet.getByText('Unsubscribed', { exact: true }).waitFor();
  await usableInBoth(page, (colorScheme) => `reader-phone-${colorScheme}-unsubscribed`);
}, 30_000);

/** Checks a screen reads in the light theme, and again once the system turns dark. */
async function usableInBoth(page: Page, screen: (colorScheme: 'light' | 'dark') => string) {
  await expectUsable(page, screen('light'));
  await page.emulateMedia({ colorScheme: 'dark' });
  await expectUsable(page, screen('dark'));
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

test('the demo newsletter’s images, once shown, are its own pictures, and its open pixel stays blocked', async () => {
  const page = await open({ ...SIZES.desktop, colorScheme: 'light' });
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
  await usableInBoth(page, (colorScheme) => `reader-desktop-${colorScheme}-newsletter-images`);
}, 30_000);

test('on a phone, a sheet keeps its time whole, and a new message’s title sits on its buttons’ line', async () => {
  const page = await open({ ...SIZES.phone, colorScheme: 'light' });
  await row(page, 'Q4 planning').click();
  const header = reader(page).getByRole('article').last().locator('header');
  await header.locator('time').waitFor();
  // The time is one line, on the recipients' line, however long the recipients are.
  const line = await header.evaluate((element) => {
    const time = element.querySelector('time')!;
    const to = time.closest('small')!.firstElementChild!;
    return {
      timeLines: time.getClientRects().length,
      sameLine: Math.abs(time.getBoundingClientRect().top - to.getBoundingClientRect().top) < 2,
    };
  });
  expect(line).toEqual({ timeLines: 1, sameLine: true });
  await page.screenshot({ path: join(RESULTS, 'reader-phone-light-time.png') });

  await page.keyboard.press('c');
  const sheet = page.locator('section[aria-label="New message"] header');
  // Middles are measured from the header's top, since the sheet may still be rising.
  const measure = () =>
    sheet.evaluate((header) => {
      const box = (selector: string) => header.querySelector(selector)?.getBoundingClientRect();
      const [whole, title, said] = [header.getBoundingClientRect(), box('h2'), box('h2 + *')];
      const middle = (of?: DOMRect) => of && Math.round(of.top + of.height / 2 - whole.top);
      return {
        title: middle(title),
        close: middle(box('button')),
        under: !!said && !!title && said.top >= title.bottom - 1,
        inside: !!said && said.bottom <= whole.bottom,
      };
    });
  const { title, close } = await measure();
  expect(Math.abs(title! - close!)).toBeLessThanOrEqual(1);
  // What saving says lies under the title, inside the header, and moves the title nowhere, at
  // its longest. Only its place matters here, so it's written in rather than saved for.
  await sheet.locator('h2 + [role="status"]').evaluate((said) => {
    said.textContent = 'Couldn’t save. Trying again…';
  });
  expect(await measure()).toMatchObject({ under: true, inside: true, title });
  await page.screenshot({ path: join(RESULTS, 'composer-phone-light-title.png') });
}, 30_000);

test('a conversation the Mailroom won’t give says so under its subject, and Try again opens it', async () => {
  const page = await open({ ...SIZES.desktop, colorScheme: 'light' });
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
  const page = await open({ ...SIZES.desktop, colorScheme: 'light' });
  await page
    .getByRole('button', { name: /^Outbox/ })
    .first()
    .click();
  await reader(page).getByText('Choosing a send opens its conversation here.').waitFor();
});

test('on a phone, the top of the screen marks and the island files', async () => {
  const page = await open({ ...SIZES.phone, colorScheme: 'light' });
  const subject = 'Workers migration plan';
  await row(page, subject).click();
  const top = page.getByRole('toolbar', { name: 'Marks' });
  const island = page.getByRole('toolbar', { name: 'Conversation' });
  await top.getByRole('button', { name: 'Flag', exact: true }).waitFor();
  await usableInBoth(page, (colorScheme) => `reader-phone-${colorScheme}`);

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

// The theme reaches only the screenshots, so each size takes one of them.
for (const [size, colorScheme] of [
  ['desktop', 'light'],
  ['phone', 'dark'],
] as const) {
  test(`mail on its way shows skeletons where it will lie, and mail that comes quickly shows none, ${size} ${colorScheme}`, async () => {
    // The composer's code is held from the start, before anything could load it ahead.
    let composerCode!: Awaited<ReturnType<typeof hold>>;
    const page = await open(
      { ...SIZES[size], colorScheme },
      { before: async (page) => (composerCode = await hold(page, /\/assets\/Composer-/)) },
    );
    const shot = (screen: string) =>
      page.screenshot({ path: join(RESULTS, `skeleton-${screen}-${size}-${colorScheme}.png`) });

    // A new message while the composer's code is on its way shows its sheet with lines.
    await page.keyboard.press('c');
    await shown(page, 'section[aria-label="Message"] [role="status"][aria-busy="true"]');
    await shot('composer');
    await composerCode.release();
    await page.locator('section[aria-label="New message"]').waitFor();
    await page.keyboard.press('Escape');
    await page.locator('section[aria-label="New message"]').waitFor({ state: 'detached' });
    await watchSkeletons(page);

    // Mail that answers within the skeletons' delay, if not at once: a conversation, an older
    // message, another view.
    const quick = await slow(page, isQuery, QUICK_MS);
    await openRow(page, 'Q4 planning');
    await bodiesShown(page);
    await unfold(page);
    await bodiesShown(page);
    await goTo(page, 'Sent', 'Personal');
    await page.getByRole('option').first().waitFor();
    await quick.restore();
    expect({ quick: await skeletonsSeen(page) }).toEqual({ quick: 0 });

    // A view not yet loaded shows rows that the first page lands on exactly.
    const list = await hold(page, 'conversations');
    await goTo(page, 'Archive', 'Personal');
    const rows = await shown(page, '[role="status"][aria-busy="true"] > div');
    await shot('list');
    await list.release();
    await page.getByRole('option').first().waitFor();
    const first = await boxOf(page, '[role="option"]');
    expect(first).toEqual(rows);

    // A conversation opened while the Mailroom is slow shows its subject in the click's own
    // frame, its sheets as skeletons, and never the empty reader. Its subject stays put.
    const slowly = await slow(page, isQuery, SLOW_MS);
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
    await slowly.restore();
    expect((await openingSeen(page)).empty).toBe(false);
    expect(await boxOf(page, 'section[aria-label="Reader"] h1')).toEqual(opening.subjectBox);

    // An older message's body on its way shows lines on its sheet, and the sheet holds still.
    const body = await hold(page, 'body');
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
    await body.release();
    await bodiesShown(page);
    expect(await boxOf(page, sheet)).toEqual(header);
    expect(await controls()).toEqual(waiting);

    // A draft opened while its words are on their way shows the composer's sheet with lines.
    const words = await hold(page, 'body');
    await goTo(page, 'Drafts', 'Personal');
    await page.getByRole('option').first().click();
    await reader(page)
      .getByRole('button', { name: /^Draft/ })
      .click();
    await shown(page, 'section[aria-label="Message"] [role="status"][aria-busy="true"]');
    await shot('draft');
    expect(await page.getByText('Opening…').count()).toBe(0);
    await words.release();
    await page
      .getByRole('button', { name: 'Send', exact: true })
      .filter({ visible: true })
      .waitFor();
  }, 60_000);
}

test('an older message’s body is asked for as the pointer rests on its line or it takes the focus', async () => {
  const page = await settled('light', (page) => openRow(page, 'Workers migration plan'));
  const asked: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes(encodeURIComponent('"body"'))) asked.push(request.url());
  });
  const lines = reader(page)
    .locator('button')
    .filter({ has: page.locator('time') });
  const [first, second] = [lines.nth(0), lines.nth(1)];

  // A pointer passing over a line asks for nothing.
  await passOver(first);
  expect(asked).toEqual([]);

  // One that rests there asks for its body, and focus asks at once.
  await first.hover();
  await until(() => asked.length === 1);
  await second.focus();
  await until(() => asked.length === 2);
}, 30_000);

// The dark theme offers light paper for the conversation open, which must ask for nothing itself.
test('a held key in the dark theme asks for no conversation it passes', async () => {
  const page = await settled('dark', (page) => page.getByRole('option').first().click());
  const asked = new Set<string>();
  page.on('request', (request) => {
    const url = decodeURIComponent(request.url());
    if (url.includes('"conversation"')) asked.add(/"s":"([^"]+::[^"]+)"/.exec(url)?.[1] ?? url);
  });
  // Twelve rows passed at a held key's pace, quicker than a rest. Only a refetch the demo's own
  // mail causes may ask for one, where asking for each row passed would ask for about twelve.
  for (let press = 0; press < 12; press++) {
    await page.keyboard.press('ArrowDown');
    await page.waitForTimeout(HELD_KEY_MS);
  }
  expect(asked.size).toBeLessThanOrEqual(2);
}, 30_000);

test('a conversation is asked for as the pointer rests on its row, and its newest body as the row is pressed', async () => {
  const page = await settled('light');
  const asked: string[] = [];
  page.on('request', (request) => {
    const url = decodeURIComponent(request.url());
    if (url.includes('"conversation"')) asked.push('conversation');
    if (url.includes('"body"')) asked.push('body');
  });
  const target = page.getByRole('option').nth(6);

  // A pointer passing over a row asks for nothing.
  await passOver(target);
  expect(asked).toEqual([]);

  // One that rests asks for the conversation, and a press for its newest body, before the click.
  await target.hover();
  await until(() => asked.includes('conversation'));
  expect(asked).not.toContain('body');
  await page.mouse.down();
  await until(() => asked.includes('body'));
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

/** Every ask of the Mailroom that changes nothing. */
const isQuery = (request: Request) => request.method() === 'GET';

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

/**
 * A desktop page at the conversation `opening` opens, or else its newest, once it has stopped asking
 * on its own for the conversations either side, as it does while idle: once nothing is on its way
 * and three idle periods in a row ask for nothing new. What it asks for after is a test's doing.
 */
async function settled(colorScheme: 'light' | 'dark', opening?: (page: Page) => Promise<unknown>) {
  const onTheirWay = new Set<Request>();
  let asked = 0;
  const arrived = (request: Request) => onTheirWay.delete(request);
  const page = await open(
    { ...SIZES.desktop, colorScheme },
    {
      before: (page) =>
        page
          .on('request', (request) => onTheirWay.add(request) && asked++)
          .on('requestfinished', arrived)
          .on('requestfailed', arrived),
    },
  );
  await opening?.(page);
  await bodiesShown(page);
  for (let quiet = 0; quiet < 3;) {
    const before = asked;
    await page.evaluate(() => new Promise((resolve) => requestIdleCallback(resolve)));
    quiet = onTheirWay.size === 0 && asked === before ? quiet + 1 : 0;
  }
  return page;
}

/**
 * Passes the pointer over an element and away, then waits longer than a rest there would have
 * taken to ask, since nothing shows a pointer that only passed asking for nothing.
 */
async function passOver(element: Locator) {
  const box = (await element.boundingBox())!;
  await element.page().mouse.move(box.x + 40, box.y + box.height / 2);
  await element.page().mouse.move(0, 0);
  await element.page().waitForTimeout(REST_MS + 250);
}
/** The pace of a held key, quicker than a rest. */
const HELD_KEY_MS = 30;
