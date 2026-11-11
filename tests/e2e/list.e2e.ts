import { expect } from 'bun:test';
import type { BrowserContext, BrowserContextOptions, Locator, Page } from 'playwright';
import { PAGE_SIZE } from '../../src/features/mailroom/client/contract.ts';
import { suite } from './suite.ts';
import { mailIsIn } from '../mailIsIn.ts';

/**
 * The conversation list: a long list as it changes under the member, as mail arrives while it is
 * scrolled down, and the avatars that lead its rows. Its own member, since what it sends lands in
 * the Inbox the other suites read, and it removes an account.
 */

const app = suite({ vars: { DEV_MEMBER: `list-${Date.now()}@trailmix.test` } });
// A test that fails leaves a screenshot of each page and what it showed, for CI to keep.
const { test } = app;

const DESKTOP = { viewport: { width: 1440, height: 900 } };
const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true };

/**
 * The rows drawn where the list is scrolled. The conversation open, the Inbox's newest, stays drawn
 * at the top wherever the list is scrolled, so it's left out.
 */
const SCROLLED = '[role="option"]:not([aria-selected="true"])';

/**
 * The Inbox, at a desktop's size unless told, recording every error and failed response. Anything
 * `before` sets on the browser is set before the page first loads.
 */
async function open(
  options: BrowserContextOptions = DESKTOP,
  before?: (context: BrowserContext) => Promise<unknown>,
) {
  const context = await app.context(options);
  await before?.(context);
  const page = await context.newPage();
  const problems: string[] = [];
  page.on('pageerror', (error) => problems.push(`page error: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(`console: ${message.text()}`);
  });
  page.on('response', (response) => {
    if (response.status() >= 400) problems.push(`${response.status()} ${response.url()}`);
  });
  // A request held back keeps the network busy, so the page counts as loaded once it is drawn.
  await page.goto(app.url, { waitUntil: before ? 'domcontentloaded' : 'networkidle' });
  await mailIsIn(page);
  return { context, page, problems };
}

test('mail that arrives while the list is scrolled down moves nothing in sight, and leads it at the top', async () => {
  const { context, page, problems } = await open();
  const list = page.locator('[role="listbox"][aria-multiselectable]');
  const length = async () =>
    Number(await list.getByRole('option').first().getAttribute('aria-setsize'));
  const before = await length();
  // Halfway down the Inbox, far past its first page, once the rows there have arrived.
  await list.evaluate((list) => (list.scrollTop = list.scrollHeight / 2));
  await page.waitForFunction(
    ({ page, drawn }) => {
      const list = document.querySelector('[role="listbox"][aria-multiselectable]');
      const first = Number(list?.querySelector(drawn)?.getAttribute('aria-posinset'));
      return list?.getAttribute('aria-busy') === 'false' && first > page;
    },
    { page: PAGE_SIZE, drawn: SCROLLED },
  );
  const inSight = () =>
    list.evaluate((list) => {
      const top = list.getBoundingClientRect().top;
      return [...list.querySelectorAll('[role="option"]')].flatMap((row) => {
        const at = Math.round(row.getBoundingClientRect().top - top);
        return at >= 0 && at < list.clientHeight ? [`${at}: ${row.textContent}`] : [];
      });
    });
  const seen = await inSight();
  expect(seen.length).toBeGreaterThan(5);

  // The demo delivers what Sam sends Sam to Sam's Inbox once its send goes.
  const subject = `Arrived while scrolled down ${Date.now()}`;
  await page.keyboard.press('c');
  const composer = page.locator('section[aria-label="New message"]');
  await composer.getByRole('textbox', { name: 'To' }).fill('sam@trailmix.test');
  await composer.getByRole('textbox', { name: 'Subject' }).fill(subject);
  await page.getByRole('status').filter({ hasText: 'Saved to Drafts' }).waitFor();
  await page.getByRole('button', { name: 'Send', exact: true }).filter({ visible: true }).click();
  await page.waitForFunction(
    (before) =>
      Number(document.querySelector('[role="option"]')?.getAttribute('aria-setsize')) > before,
    before,
    { timeout: 30_000 },
  );

  expect(await length()).toBe(before + 1);
  expect(await inSight()).toEqual(seen);
  await list.evaluate((list) => (list.scrollTop = 0));
  await list.getByRole('option').first().filter({ hasText: subject }).waitFor({ timeout: 5_000 });
  expect(problems).toEqual([]);
  await context.close();
}, 60_000);

test('a list dragged far down asks for no page on the way, only for where it stops', async () => {
  const { context, page, problems } = await open();
  const list = page.locator('[role="listbox"][aria-multiselectable]');
  await list.getByRole('option').first().waitFor();
  // The places of the pages the list asks for, past its first.
  const asked: number[] = [];
  page.on('request', (request) => {
    const payload = decodeURIComponent(request.url());
    const at = /"s":"conversations".*?"t":0,"s":(\d+)/.exec(payload)?.[1];
    if (at && Number(at) > 0) asked.push(Number(at));
  });

  // A thumb dragged halfway down over half a second, the list moving a long way each frame.
  await list.evaluate(
    (list) =>
      new Promise<void>((resolve) => {
        let frame = 0;
        const step = () => {
          list.scrollTop = (list.scrollHeight / 2) * (++frame / 30);
          if (frame < 30) requestAnimationFrame(step);
          else resolve();
        };
        requestAnimationFrame(step);
      }),
  );
  const onTheWay = asked.length;
  await page.waitForFunction((drawn) => {
    const list = document.querySelector('[role="listbox"][aria-multiselectable]');
    return list?.getAttribute('aria-busy') === 'false' && list.querySelector(drawn);
  }, SCROLLED);
  const first = Number(await list.locator(SCROLLED).first().getAttribute('aria-posinset'));

  expect(onTheWay).toBe(0);
  // The pages in sight where it stopped, with the rows either side that arrive ahead.
  expect(asked.length).toBeGreaterThan(0);
  expect(asked.every((at) => Math.abs(at - first) < 2 * PAGE_SIZE)).toBe(true);
  expect(problems).toEqual([]);
  await context.close();
}, 30_000);

test('End selects the last conversation once its page arrives', async () => {
  const { context, page, problems } = await open();
  const list = page.locator('[role="listbox"][aria-multiselectable]');
  const length = Number(await list.getByRole('option').first().getAttribute('aria-setsize'));
  expect(length).toBeGreaterThan(PAGE_SIZE);

  await list.focus();
  await page.keyboard.press('End');
  await list
    .locator(`[role="option"][aria-selected="true"][aria-posinset="${length}"]`)
    .waitFor({ timeout: 5_000 });
  expect(problems).toEqual([]);
  await context.close();
}, 30_000);

test('a row leads with its sender’s picture when verified, or their initials, the same as the reader’s sheet', async () => {
  const { context, page, problems } = await open();
  // Mail from Kernel Weekly, Ada and Fieldnote Studio is verified: Kernel Weekly has a logo, Ada a
  // photo and Fieldnote Studio's site an icon. Kwame writes as himself.
  for (const sender of ['Kernel Weekly', 'Ada, Sam', 'Fieldnote Studio']) {
    const picture = avatarOf(page, sender).locator('img');
    await expect(
      picture.evaluate((image: HTMLImageElement) => image.naturalWidth),
    ).resolves.toBeGreaterThan(0);
  }
  expect(await avatarOf(page, 'Kwame Mensah').textContent()).toBe('KM');
  // The avatar is the newest sender who isn't the member: Sam is the member here.
  expect(await avatarOf(page, 'Sam, Jonas').textContent()).toBe('JW');
  for (const sender of ['Kernel Weekly', 'Kwame Mensah']) {
    const box = await avatarOf(page, sender).locator('[data-avatar]').boundingBox();
    expect([box?.width, box?.height]).toEqual([32, 32]);
  }

  await row(page, 'Kernel Weekly').click();
  const sheet = page.getByRole('article', { name: 'Message from Kernel Weekly' });
  await expect(
    sheet.locator('header img').evaluate((image: HTMLImageElement) => image.naturalWidth),
  ).resolves.toBeGreaterThan(0);
  await row(page, 'Kwame Mensah').click();
  await page
    .getByRole('article', { name: 'Message from Kwame Mensah' })
    .locator('header')
    .getByText('KM', { exact: true })
    .waitFor();
  expect(problems).toEqual([]);
  await context.close();
}, 30_000);

test('a picture on its way leaves its initials until it has loaded, and one the browser holds shows at once', async () => {
  // Dark, where an empty light plate would show as a white disc, with the pictures held back from
  // a browser that has never had them, since it would keep them for good.
  const { promise: arrived, resolve: arrive } = Promise.withResolvers<void>();
  const { context, page, problems } = await open(
    { ...DESKTOP, colorScheme: 'dark', serviceWorkers: 'block' },
    (context) =>
      context.route('**/avatars/**', async (route) => {
        await arrived;
        await route.continue();
      }),
  );
  const kernel = avatarOf(page, 'Kernel Weekly').locator('[data-avatar]');
  await kernel.waitFor();
  const plateOf = (avatar: Locator) =>
    avatar
      .locator(':scope > span')
      .first()
      .evaluate((plate) => getComputedStyle(plate).backgroundColor);
  expect(await kernel.getAttribute('data-avatar')).toBe('initials');
  expect(await kernel.textContent()).toBe('KW');
  expect(await plateOf(kernel)).toBe(
    await plateOf(avatarOf(page, 'Kwame Mensah').locator('[data-avatar]')),
  );

  // Every frame from here, as each avatar on screen paints in it.
  await page.evaluate(() => {
    const frames: Frame[] = [];
    Object.assign(window, { frames_: frames });
    const sample = () => {
      for (const avatar of document.querySelectorAll<HTMLElement>('[data-avatar]')) {
        const image = avatar.querySelector('img');
        frames.push({
          row: avatar.closest('[role="option"]')?.textContent?.slice(0, 24) ?? 'sheet',
          state: avatar.dataset.avatar ?? '',
          initials: avatar.textContent ?? '',
          loaded: image ? image.complete && image.naturalWidth > 0 : false,
          seen: image ? getComputedStyle(image).opacity !== '0' : false,
        });
      }
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  // The pictures come only once a frame has painted without them, which a fast machine can
  // otherwise beat.
  await page.waitForFunction(() => (window as unknown as { frames_: Frame[] }).frames_.length > 0);
  arrive();
  await page.waitForFunction(() =>
    [...document.querySelectorAll('[role="option"]')].some(
      (row) =>
        row.textContent?.includes('Kernel Weekly') && row.querySelector('[data-avatar="picture"]'),
    ),
  );
  const frames = await page.evaluate(() => (window as unknown as { frames_: Frame[] }).frames_);
  // Never an empty disc: initials until the picture has loaded, then the picture alone.
  for (const frame of frames) {
    if (frame.state === 'picture')
      expect(frame).toMatchObject({ loaded: true, seen: true, initials: '' });
    else expect(frame).toMatchObject({ state: 'initials', seen: false });
    if (frame.state === 'initials') expect(frame.initials).not.toBe('');
  }
  const kernels = frames
    .filter(({ row }) => row.includes('Kernel Weekly'))
    .map(({ state }) => state);
  expect(kernels[0]).toBe('initials');
  expect(kernels.at(-1)).toBe('picture');

  // Back in a view after another, its pictures show from the first frame its rows paint in.
  const sidebar = page.getByRole('navigation', { name: 'Mailboxes' });
  await sidebar
    .getByRole('region', { name: 'Personal' })
    .getByRole('button', { name: /^Sent( \d+)?$/ })
    .click();
  await page.getByRole('heading', { name: 'Sent', level: 2 }).waitFor();
  await page.evaluate(() => {
    (window as unknown as { frames_: Frame[] }).frames_.length = 0;
  });
  await sidebar
    .getByRole('button', { name: /^Inbox( \d+)?$/ })
    .first()
    .click();
  await page.waitForFunction(() =>
    (window as unknown as { frames_: Frame[] }).frames_.some(({ row }) =>
      row.includes('Kernel Weekly'),
    ),
  );
  const back = await page.evaluate(() => (window as unknown as { frames_: Frame[] }).frames_);
  expect(back.find(({ row }) => row.includes('Kernel Weekly'))?.state).toBe('picture');
  expect(problems).toEqual([]);
  await context.close();
}, 30_000);

/** How an avatar painted in one frame. */
type Frame = { row: string; state: string; initials: string; loaded: boolean; seen: boolean };

test('on a phone, tapping a row’s avatar picks the row, on a target 44 pixels across', async () => {
  const { context, page, problems } = await open(PHONE);
  const target = avatarOf(page, 'Kwame Mensah');
  const box = await target.boundingBox();
  expect(box!.width).toBeGreaterThanOrEqual(44);
  expect(box!.height).toBeGreaterThanOrEqual(44);

  await target.tap();
  await page.getByRole('toolbar', { name: 'Picked conversations' }).waitFor();
  await avatarOf(page, 'Kernel Weekly').tap();
  const picked = page.locator('[role="option"][aria-selected="true"]');
  await expect(picked.count()).resolves.toBe(2);
  // Picking keeps the list in view: the reader never slid over it.
  const list = page.locator('[role="listbox"][aria-multiselectable]');
  expect(await list.evaluate((list) => list.closest('[inert]') === null)).toBe(true);
  await avatarOf(page, 'Kernel Weekly').tap();
  await expect(picked.count()).resolves.toBe(1);
  expect(problems).toEqual([]);
  await context.close();
}, 30_000);

test('a conversation only the member wrote names whom it went to, and leads with the first of them', async () => {
  const { context, page, problems } = await open();
  const sidebar = page.getByRole('navigation', { name: 'Mailboxes' });

  // Sent holds the cabin bookings Sam sent Rae, and nobody wrote back.
  await sidebar
    .getByRole('region', { name: 'Personal' })
    .getByRole('button', { name: /^Sent( \d+)?$/ })
    .click();
  await page.getByRole('heading', { name: 'Sent', level: 2 }).waitFor();
  await row(page, 'Booking the cabin').waitFor();
  expect(await row(page, 'Booking the cabin').textContent()).toStartWith('RHTo Rae Holm');

  // Drafts names whom each is to, by first names for several, and leads with the first of them:
  // Sofia's picture, which her verified mail brought, and Rae's initials.
  await sidebar
    .getByRole('button', { name: /^Drafts( \d+)?$/ })
    .first()
    .click();
  await page.getByRole('heading', { name: 'Drafts', level: 2 }).waitFor();
  await row(page, 'To Sofia, Priya, Kwame').waitFor();
  await expect(
    avatarOf(page, 'To Sofia, Priya, Kwame')
      .locator('img')
      .evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth),
  ).resolves.toBeGreaterThan(0);
  expect(await avatarOf(page, 'To Rae Holm').textContent()).toBe('RH');

  // A draft addressed to nobody yet says so, in the muted ink of a row's preview.
  const subject = `Nobody yet ${Date.now()}`;
  await page.keyboard.press('c');
  await page
    .locator('section[aria-label="New message"]')
    .getByRole('textbox', { name: 'Subject' })
    .fill(subject);
  await page.getByRole('status').filter({ hasText: 'Saved to Drafts' }).waitFor();
  const nobody = row(page, subject).getByText('No recipients', { exact: true });
  await nobody.waitFor({ timeout: 10_000 });
  const inkOf = (text: Locator) => text.evaluate((element) => getComputedStyle(element).color);
  expect(await inkOf(nobody)).toBe(await inkOf(row(page, 'To Rae Holm').getByText(/^Hi Rae/)));
  expect(problems).toEqual([]);
  await context.close();
}, 60_000);

// Last, since it removes an account.
test('the stamp marks rows only where a list mixes accounts', async () => {
  const { context, page, problems } = await open();
  const stamps = () => page.locator('[role="option"] [data-stamp]').count();
  // The unified Inbox mixes Personal and Work.
  expect(await stamps()).toBeGreaterThan(0);
  expect(
    await avatarOf(page, 'Kwame Mensah').locator('[data-stamp]').getAttribute('data-stamp'),
  ).toBeTruthy();

  // One account's folder doesn't.
  await page
    .getByRole('region', { name: 'Personal' })
    .getByRole('button', { name: /^Inbox/ })
    .click();
  await page.getByRole('heading', { name: 'Inbox', level: 2 }).waitFor();
  await page.getByRole('option').first().waitFor();
  expect(await stamps()).toBe(0);

  // Nor does the unified Inbox of a member with one account.
  await page
    .getByRole('region', { name: 'Work' })
    .getByRole('button', { name: 'More for Work' })
    .click();
  await page.getByRole('menuitem', { name: 'Remove the Work account' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Remove' }).click();
  await page.getByRole('region', { name: 'Work' }).waitFor({ state: 'detached' });
  await page
    .getByRole('button', { name: /^Inbox/ })
    .first()
    .click();
  await page.getByRole('option').first().waitFor();
  expect(await stamps()).toBe(0);
  expect(problems).toEqual([]);
  await context.close();
}, 30_000);

/** The list's first row from a sender, or with these senders. */
const row = (page: Page, senders: string) =>
  page.getByRole('option').filter({ hasText: senders }).first();

/** The avatar leading a row, where a finger taps it. */
const avatarOf = (page: Page, senders: string) =>
  row(page, senders).locator(':scope > span').first();
