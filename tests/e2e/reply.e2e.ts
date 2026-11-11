// Replying without waiting: the composer opens under its conversation at once, however slowly the
// server answers, says what it's saving in a place of its own, and a sent reply takes its place at
// the end of its conversation while it leaves. Each at a desktop's size and a phone's, as a member
// of their own, in both themes.
import { afterEach, describe, expect } from 'bun:test';
import { join } from 'node:path';
import type { BrowserContextOptions, Page, Route } from 'playwright';
import { unreadableText } from './contrast.ts';
import { suite } from './suite.ts';

const SIZES = {
  desktop: { viewport: { width: 1440, height: 900 } },
  phone: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
} as const;
const SHOTS = join(import.meta.dir, '../../test-results');
/** How long a slow server takes to send a message's body. */
const SLOW_MS = 3000;
const LIST = 'ridge@lists.example';

/** Every error a page threw during a test, which fails it. */
const errors: string[] = [];
afterEach(() => {
  expect(errors.splice(0)).toEqual([]);
});

/**
 * Has the server send each message's body only after `SLOW_MS`, or once `held` settles, and say in
 * it that replies go to the list, as a mailing list's Reply-To does.
 */
async function slowBodies(
  page: Page,
  held: () => Promise<unknown> = () => new Promise((resolve) => setTimeout(resolve, SLOW_MS)),
) {
  await page.route('**/_serverFn/**', async (route: Route) => {
    const asked = decodeURIComponent(route.request().url());
    if (route.request().method() !== 'GET' || !asked.includes('{"t":1,"s":"body"}')) {
      return route.fallback();
    }
    const response = await route.fetch();
    const said = (await response.text()).replace(
      /\{"t":1,"s":"Date"\},\{"t":1,"s":"[^"]*"\}/,
      `{"t":1,"s":"Reply-To"},{"t":1,"s":"${LIST}"}`,
    );
    await held();
    await route.fulfill({ response, body: said });
  });
}

/**
 * Has the server send each conversation only after `SLOW_MS`, as when a host files its copy in Sent
 * late, so the Outbox lets a send go before the index shows its copy.
 */
async function slowIndex(page: Page) {
  await page.route('**/_serverFn/**', async (route: Route) => {
    const asked = decodeURIComponent(route.request().url());
    if (route.request().method() !== 'GET' || !asked.includes('{"t":1,"s":"conversation"}')) {
      return route.fallback();
    }
    const response = await route.fetch();
    await new Promise((resolve) => setTimeout(resolve, SLOW_MS));
    await route.fulfill({ response });
  });
}

for (const [size, options] of Object.entries(SIZES)) {
  describe(`Replying at a ${size}’s size`, () => {
    const app = suite({ vars: { DEV_MEMBER: `reply-${size}-${Date.now()}@trailmix.test` } });
    const { test } = app;

    /**
     * The Inbox, which opens at its newest and prepares the conversations beside it. What `before`
     * sets up, such as a slow server, is in place before the page asks for anything.
     */
    async function inbox(
      colorScheme: 'light' | 'dark',
      more: BrowserContextOptions = {},
      before: (page: Page) => Promise<void> = async () => {},
    ) {
      const page = await (await app.context({ ...options, colorScheme, ...more })).newPage();
      page.on('pageerror', (error) => errors.push(error.message));
      await before(page);
      await page.goto(app.url);
      await page.getByText('Up to date').waitFor({ state: 'attached', timeout: 30_000 });
      return page;
    }

    const reader = (page: Page) => page.getByRole('region', { name: 'Reader' });
    const composer = (page: Page) => page.locator('section[aria-label="Reply"]');

    /** Opens a conversation of several messages, and waits until it shows. */
    async function open(page: Page, subject = 'Workers migration plan') {
      await page.getByRole('option').filter({ hasText: subject }).first().click();
      await reader(page).getByRole('heading', { level: 1, name: subject, exact: false }).waitFor();
    }

    test('Reply opens at once while the server is slow, and goes to the list once the parent says', async () => {
      // The parent's body comes only once the reply has been saved, addressed as it was before.
      const saves = (page: Page, to: 'sender' | 'list') =>
        page.waitForResponse((response) => {
          const sent = response.request().postData() ?? '';
          return sent.includes('saveDraft') && sent.includes(LIST) === (to === 'list');
        });
      let savedToSender: Promise<unknown> = Promise.resolve();
      const page = await inbox('light', {}, async (page) => {
        savedToSender = saves(page, 'sender');
        await slowBodies(page, () => savedToSender);
      });
      await open(page);
      await composerLoaded(page);
      // Before the newest message's body has come, and typed straight after, as a typist does.
      const savedToList = saves(page, 'list');
      await page.keyboard.press('r');
      await page.keyboard.type('Count me in.');
      const reply = composer(page);
      const editor = reply.getByRole('textbox', { name: 'Reply' });
      await editor.waitFor({ timeout: SLOW_MS / 2 });
      expect(await reply.getByText('Opening…').count()).toBe(0);
      expect(await editor.innerText()).toBe('Count me in.');
      const to = reply.getByRole('textbox', { name: 'To' });
      expect(await to.inputValue()).not.toContain(LIST);
      // Once the parent says, the reply goes to the list, and so does the draft that will be sent.
      await savedToSender;
      await until(async () => (await to.inputValue()) === LIST, SLOW_MS + 5000);
      await savedToList;
      await readable(page, size, 'light-opened');
    }, 60_000);

    test('whom the member chose a reply is to stays chosen when the parent’s Reply-To comes', async () => {
      const page = await inbox('dark');
      await slowBodies(page);
      const bodyCame = page.waitForResponse((response) =>
        decodeURIComponent(response.url()).includes('{"t":1,"s":"body"}'),
      );
      await open(page);
      await page.keyboard.press('r');
      const to = composer(page).getByRole('textbox', { name: 'To' });
      await to.fill('kwame@example.net');
      await bodyCame;
      await painted(page);
      expect(await to.inputValue()).toBe('kwame@example.net');
    }, 60_000);

    test('saving is said inside the composer, and nothing else moves for it', async () => {
      // A desktop's reader at its narrowest, where the toolbar has the least room.
      const narrow = { viewport: { width: 1024, height: 768 } };
      const page = await inbox('dark', size === 'desktop' ? narrow : {});
      await open(page);
      await composerLoaded(page);
      await page.keyboard.press('r');
      const reply = composer(page);
      await reply.getByRole('textbox', { name: 'Reply' }).waitFor();
      await page.evaluate(() => {
        const moved: string[] = [];
        (window as unknown as { moved: string[] }).moved = moved;
        new PerformanceObserver((list) => {
          for (const entry of list.getEntries() as unknown as {
            sources?: { node?: Node | null }[];
          }[]) {
            for (const { node } of entry.sources ?? []) {
              const element = node instanceof Element ? node : node?.parentElement;
              const isStatus = element?.closest('section[aria-label="Reply"] [role="status"]');
              if (!isStatus) moved.push(element?.outerHTML.slice(0, 120) ?? 'something');
            }
          }
        }).observe({ type: 'layout-shift' });
      });
      let saves = 0;
      page.on('request', (request) => {
        if (request.method() === 'POST' && request.postData()?.includes('saveDraft')) saves++;
      });
      const saved = reply.getByRole('status').filter({ hasText: 'Saved to Drafts' });
      await page.keyboard.type('Sounds right to me.');
      await saved.waitFor({ timeout: 10_000 });
      await readable(page, size, 'dark-saved');
      await page.keyboard.type(' See you Thursday.');
      await until(() => Promise.resolve(saves >= 2), 10_000);
      await saved.waitFor({ timeout: 10_000 });
      await painted(page);
      expect(await page.evaluate(() => (window as unknown as { moved: string[] }).moved)).toEqual(
        [],
      );
    }, 60_000);

    test('a reply closed untouched leaves nothing on the server', async () => {
      const page = await inbox('light');
      await open(page);
      await composerLoaded(page);
      const drafts = reader(page).getByRole('button', { name: /^Draft/ });
      const before = await drafts.count();
      let saves = 0;
      page.on('request', (request) => {
        if (request.method() === 'POST' && request.postData()?.includes('saveDraft')) saves++;
      });
      await page.keyboard.press('r');
      await composer(page).getByRole('textbox', { name: 'Reply' }).waitFor();
      await page.keyboard.press('Escape');
      await composer(page).waitFor({ state: 'detached' });
      await painted(page);
      expect({ saves, drafts: await drafts.count() }).toEqual({ saves: 0, drafts: before });
    }, 60_000);

    /** Writes a reply to the conversation open in `page`, and sends it. */
    async function sendReply(page: Page, text: string) {
      await page.keyboard.press('r');
      const reply = composer(page);
      await reply.getByRole('textbox', { name: 'Reply' }).waitFor();
      await page.keyboard.type(text);
      await reply.getByRole('status').filter({ hasText: 'Saved to Drafts' }).waitFor();
      await page.keyboard.press('ControlOrMeta+Enter');
    }

    test('a reply sent lies at the end of its conversation at once, and becomes the server’s copy when the index has it', async () => {
      const page = await inbox('light');
      await open(page);
      await slowIndex(page);
      const text = 'Thursday works for the cutover.';
      await watch(page, text);
      await sendReply(page, text);
      await sentShows(page, text, 'light-sent');
      // The copy in Sent takes its place.
      const copy = reader(page).locator('button', { hasText: text });
      await copy.waitFor({ timeout: 60_000 });
      await painted(page);
      const sent = afterSend(await shown(page));
      expect(sent[0]).toEqual({ composer: false, leaving: 1, running: 1, copies: 0, drafts: 0 });
      expect(
        sent.filter((frame) => frame.leaving + frame.copies !== 1 || frame.drafts > 0),
      ).toEqual([]);
      expect(sent.at(-1)).toMatchObject({ leaving: 0, copies: 1 });
      expect(await copy.locator('time').count()).toBe(1);
    }, 90_000);

    test('Undo brings the composer back as it was, and takes the reply from its conversation', async () => {
      // A short window, where the end of the conversation starts out of view.
      const page = await inbox('dark', { viewport: { ...options.viewport, height: 600 } });
      await open(page);
      const text = 'On second thought, Friday.';
      await watch(page, text);
      await sendReply(page, text);
      await sentShows(page, text, 'dark-sent');
      await page.getByRole('button', { name: 'Undo', exact: true }).first().click();
      const editor = composer(page).getByRole('textbox', { name: 'Reply' });
      await editor.waitFor();
      await painted(page);
      expect(await editor.innerText()).toBe(text);
      const sent = afterSend(await shown(page));
      const back = sent.findIndex(({ composer }) => composer);
      expect(sent.slice(0, back).every(({ leaving }) => leaving === 1)).toBe(true);
      expect(sent.slice(back)).toEqual([
        { composer: true, leaving: 0, running: 0, copies: 0, drafts: 0 },
      ]);
    }, 60_000);

    test('airmail runs while a reply leaves, and stands still, still drawn, when motion is reduced', async () => {
      for (const motion of ['no-preference', 'reduce'] as const) {
        const page = await inbox('light', { reducedMotion: motion, forcedColors: 'active' });
        await open(page);
        const text = `Running airmail, ${motion}.`;
        await sendReply(page, text);
        const bands = page.locator('[data-airmail] > *');
        await reader(page).locator('div:has(> [data-airmail])', { hasText: text }).waitFor();
        await page.locator('.astryx-toast [data-airmail]').waitFor();
        const drawn = await bands.evaluateAll((all) =>
          all.map((band) => ({
            isRunning: band.getAnimations().length > 0,
            isDrawn:
              getComputedStyle(band).backgroundImage !== 'none' &&
              getComputedStyle(band).forcedColorAdjust === 'none',
          })),
        );
        expect(drawn.length).toBeGreaterThanOrEqual(2);
        expect(drawn).toEqual(
          drawn.map(() => ({ isRunning: motion === 'no-preference', isDrawn: true })),
        );
        if (motion === 'reduce') {
          await page.screenshot({ path: join(SHOTS, `reply-${size}-forced-still.png`) });
        }
        await page.getByRole('button', { name: 'Undo', exact: true }).first().click();
        await composer(page).getByRole('textbox', { name: 'Reply' }).waitFor();
      }
    }, 90_000);
  });
}

/**
 * Waits for a reply just sent to lie at the end of its conversation under running airmail, with its
 * toast on paper, and checks both read.
 */
async function sentShows(page: Page, text: string, screen: string) {
  const onItsWay = page
    .getByRole('region', { name: 'Reader' })
    .locator('div:has(> [data-airmail])', { hasText: text });
  await onItsWay.waitFor({ timeout: 2000 });
  expect(await onItsWay.locator('[data-airmail]').getAttribute('data-airmail')).toBe('running');
  const toastCard = page.locator('.astryx-toast').first();
  await toastCard.waitFor();
  // The member sees it leave: on screen, and clear of the toast.
  await until(async () => {
    const [line, toast] = await Promise.all([onItsWay.boundingBox(), toastCard.boundingBox()]);
    return !!line && !!toast && line.y >= 0 && line.y + line.height <= toast.y;
  }, 2000);
  expect(await toastCard.evaluate(onPaper)).toBe(true);
  await readable(page, sizeOf(page), screen);
}

const sizeOf = (page: Page) => ((page.viewportSize()?.width ?? 0) < 768 ? 'phone' : 'desktop');

/** One painted frame of a reply sent, as the reader shows it. */
type Frame = {
  composer: boolean;
  leaving: number;
  running: number;
  copies: number;
  drafts: number;
};

/**
 * Notes what each frame painted from now on shows of the reply that says `text`: whether its
 * composer is open, and how often the reader shows it on its way, as the server's copy and as a
 * draft. A frame like the one before isn't noted again.
 */
async function watch(page: Page, text: string) {
  await page.evaluate((text) => {
    const frames: Frame[] = [];
    (window as unknown as { frames_: Frame[] }).frames_ = frames;
    const look = () => {
      const reader = document.querySelector('section[aria-label="Reader"]');
      const lines = [
        ...(reader?.querySelectorAll('button, div:has(> [data-airmail])') ?? []),
      ].filter((line) => line.textContent?.includes(text));
      const buttons = lines.filter((line) => line.tagName === 'BUTTON');
      const frame: Frame = {
        composer: document.querySelector('section[aria-label="Reply"]') !== null,
        leaving: lines.length - buttons.length,
        running: lines.filter((line) => line.querySelector('[data-airmail="running"]')).length,
        copies: buttons.filter((line) => !line.textContent?.startsWith('Draft')).length,
        drafts: buttons.filter((line) => line.textContent?.startsWith('Draft')).length,
      };
      if (JSON.stringify(frame) !== JSON.stringify(frames.at(-1))) frames.push(frame);
      requestAnimationFrame(look);
    };
    requestAnimationFrame(look);
  }, text);
}

const shown = (page: Page) =>
  page.evaluate(() => (window as unknown as { frames_: Frame[] }).frames_);

/** The frames from the one that closed the composer on Send. */
function afterSend(frames: Frame[]): Frame[] {
  const opened = frames.findIndex(({ composer }) => composer);
  return frames.slice(frames.findIndex(({ composer }, at) => at > opened && !composer));
}

/** Whether an element lies on the theme's paper, the color its sheets are, as a screen shows it. */
function onPaper(element: Element): boolean {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 1;
  const ink = canvas.getContext('2d', { willReadFrequently: true })!;
  const shown = (css: string) => {
    ink.clearRect(0, 0, 1, 1);
    ink.fillStyle = css;
    ink.fillRect(0, 0, 1, 1);
    return ink.getImageData(0, 0, 1, 1).data.join();
  };
  const probe = document.createElement('div');
  probe.style.backgroundColor = 'var(--color-background-card)';
  element.parentElement?.append(probe);
  const paper = getComputedStyle(probe).backgroundColor;
  probe.remove();
  return shown(getComputedStyle(element).backgroundColor) === shown(paper);
}

/**
 * Waits until the composer and its Send have loaded, as they have once a member has read for a
 * moment before replying.
 */
const composerLoaded = (page: Page) =>
  page.waitForFunction(() =>
    ['Composer-', 'SendActions-'].every((chunk) =>
      performance
        .getEntriesByType('resource')
        .some(({ name }) => name.includes(`/assets/${chunk}`)),
    ),
  );

/** Waits for two more frames to paint, and for what they report to be delivered. */
const painted = (page: Page) =>
  page.evaluate(
    () =>
      new Promise((done) =>
        requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(done, 0))),
      ),
  );

/** Waits until a check holds, or fails once `ms` have passed without it. */
async function until(check: () => Promise<boolean>, ms: number) {
  const by = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > by) throw new Error(`Still not so after ${ms} ms.`);
    await new Promise((done) => setTimeout(done, 25));
  }
}

async function readable(page: Page, size: string, screen: string) {
  // Running airmail never finishes, so only what ends is waited for.
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter(({ effect }) => effect?.getTiming().iterations !== Infinity)
        .map(({ finished }) => finished),
    ),
  );
  await page.screenshot({ path: join(SHOTS, `reply-${size}-${screen}.png`) });
  expect({ screen, unreadable: await unreadableText(page) }).toEqual({ screen, unreadable: [] });
}
