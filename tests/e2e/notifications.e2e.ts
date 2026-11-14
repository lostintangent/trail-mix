import { afterEach, beforeAll, expect } from 'bun:test';
import { generateKeyPairSync } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { BrowserContext, BrowserContextOptions, Page } from 'playwright';
import { addressOf } from '../../src/features/mail/core/index.ts';
import { readMessagePath } from '../../src/features/mailroom/client/urls.ts';
import { pushOf, type Notice } from '../../src/features/notifications/core/index.ts';
import { unusable } from './usable.ts';
import { suite } from './suite.ts';
import { mailIsIn } from '../mailIsIn.ts';
import { atRest } from '../atRest.ts';

/**
 * Notifications in the browser: Settings' switch and its command on a deployment that has a push
 * key, the installed app subscribing and the Mailroom knowing it, and the service worker showing a
 * push and acting on a tap or a button. A test can't reach Chromium's push service, and headless Chromium
 * shows no notifications, so three things stand in: the page's PushManager, which keeps one
 * subscription in the page's storage, the page's permission, which headless Chromium always says
 * is denied, and the worker's `showNotification`, which records what it would show. A push arrives
 * through the DevTools protocol, as Chromium's own "Push" button sends one.
 */

const SHOTS = join(import.meta.dir, '../../test-results');
const DESKTOP = { viewport: { width: 1440, height: 900 } };
const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true };
const IPHONE_SAFARI =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.4 Mobile/15E148 Safari/604.1';

/** The deployment's push key, in one line, which `pushKeyOf` reads as the PEM it would be. */
const PUSH_KEY = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  .privateKey.export({ type: 'pkcs8', format: 'der' })
  .toString('base64');

/** The one device the stand-in PushManager subscribes, with keys a browser could have made. */
const DEVICE = {
  endpoint: 'https://push.example/devices/e2e',
  expirationTime: null,
  keys: {
    p256dh: generateKeyPairSync('ec', { namedCurve: 'P-256' })
      .publicKey.export({ type: 'spki', format: 'der' })
      .subarray(-65)
      .toString('base64url'),
    auth: Buffer.alloc(16, 7).toString('base64url'),
  },
};

const app = suite({
  vars: {
    DEV_MEMBER: `notifications-${Date.now()}@trailmix.test`,
    PUSH_KEY,
    OPERATOR_EMAIL: 'operator@trailmix.test',
  },
});
const { test } = app;

beforeAll(() => {
  mkdirSync(SHOTS, { recursive: true });
});

/** Every error a page threw during a test, which fails it. */
const errors: string[] = [];
afterEach(() => {
  expect(errors.splice(0)).toEqual([]);
});

/** Settings' switch for this device's notifications, or only while it shows them on or off. */
const notifying = (page: Page, checked?: boolean) =>
  page
    .getByRole('region', { name: 'Settings' })
    .getByRole('switch', { name: 'Notifications on this device', checked });

/** Opens Settings from the gear at the foot of the sidebar, which a phone slides into view first. */
async function openSettings(page: Page) {
  if ((page.viewportSize()?.width ?? 0) < 768) {
    await page.getByRole('button', { name: 'Folders', exact: true }).click();
  }
  await page.getByRole('button', { name: 'Open settings' }).click();
  await page.getByRole('heading', { name: 'Settings', level: 1 }).waitFor();
}

/** Waits until the switch shows notifications on, or off. */
const isOn = (page: Page, on: boolean) => notifying(page, on).waitFor({ timeout: 10_000 });

async function open(
  options: BrowserContextOptions,
  prepare?: (context: BrowserContext) => Promise<void>,
) {
  const context = await app.context({ deviceScaleFactor: 2, ...options });
  await prepare?.(context);
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(app.url);
  await mailIsIn(page);
  return { context, page };
}

/** Trail Mix as an installed app, allowed to notify, with the stand-in PushManager. */
async function installed(options: BrowserContextOptions = DESKTOP) {
  const opened = await open({ ...options, colorScheme: 'light' }, async (context) => {
    await context.grantPermissions(['notifications'], { origin: app.url });
    await context.addInitScript(() => {
      const real = window.matchMedia.bind(window);
      window.matchMedia = (query: string) =>
        query === '(display-mode: standalone)'
          ? ({ matches: true, media: query } as MediaQueryList)
          : real(query);
    });
    await context.addInitScript(standInPushManager, DEVICE);
    await context.addInitScript(() =>
      Object.defineProperty(Notification, 'permission', { get: () => 'granted' }),
    );
    // Which event each ask of the browser's leave came during. Safari asks only from the tap itself.
    await context.addInitScript(() => {
      const asked: string[] = [];
      Object.assign(window, { asked });
      const real = Notification.requestPermission.bind(Notification);
      Notification.requestPermission = () => {
        asked.push(window.event?.type ?? 'no event');
        return real();
      };
    });
  });
  await opened.page.waitForFunction(() => navigator.serviceWorker.controller !== null, undefined, {
    timeout: 15_000,
  });
  return opened;
}

test('in a browser tab, Settings says notifications come to the installed app, and on an iPhone to its Home Screen', async () => {
  for (const [options, says] of [
    [{ ...DESKTOP, colorScheme: 'dark' }, 'Notifications come to Trail Mix installed as an app.'],
    [
      { ...PHONE, colorScheme: 'light', userAgent: IPHONE_SAFARI },
      'On iPhone, notifications come to Trail Mix on the Home Screen.',
    ],
  ] as const) {
    const { page, context } = await open(options);
    await openSettings(page);
    await page.getByRole('region', { name: 'Settings' }).getByText(says).waitFor();
    expect(await notifying(page).isDisabled()).toBe(true);
    // On a desktop, the palette's command says the same, as a toast beside it.
    if (options.viewport.width >= 768) {
      await page.getByRole('searchbox', { name: 'Search mail' }).click();
      await page.keyboard.type('turn on notifications');
      await page
        .getByRole('listbox', { name: 'Commands' })
        .getByRole('option')
        .filter({ hasText: 'Turn on notifications on this device' })
        .click();
      await page.getByText(says).nth(1).waitFor();
    }
    await context.close();
  }
}, 60_000);

test('the installed app turns notifications on and off in Settings, and the Mailroom knows it across reloads', async () => {
  const { page } = await installed();
  await openSettings(page);
  await notifying(page).click();
  await isOn(page, true);
  // The browser was asked during the tap, not after waiting on code that hadn't loaded.
  expect(await page.evaluate(() => (window as unknown as { asked: string[] }).asked)).toEqual([
    'click',
  ]);
  expect(await page.evaluate(() => localStorage.getItem('test.push-subscription'))).toContain(
    'push.example/devices/e2e',
  );
  await rowsAgree(page);
  await shot(page, 'desktop-light-on');
  await page.emulateMedia({ colorScheme: 'dark' });
  // A theme changes over 125 ms, and a screen read mid-change has colors from both.
  await atRest(page);
  await rowsAgree(page);
  await shot(page, 'desktop-dark-on');
  await page.emulateMedia({ colorScheme: 'light' });

  // The Mailroom says this device is notified.
  await page.reload();
  await openSettings(page);
  await isOn(page, true);

  await notifying(page).click();
  await isOn(page, false);
  expect(await page.evaluate(() => localStorage.getItem('test.push-subscription'))).toBeNull();
  await page.reload();
  await openSettings(page);
  await isOn(page, false);
}, 60_000);

test('on a phone, Settings’ switch turns on with a tap, in both themes', async () => {
  for (const colorScheme of ['light', 'dark'] as const) {
    const { page, context } = await installed(PHONE);
    await page.emulateMedia({ colorScheme });
    await page.getByRole('button', { name: 'Folders', exact: true }).click();
    await page.getByRole('button', { name: 'Open settings' }).click();
    await notifying(page).waitFor();
    await atRest(page);
    await notifying(page).tap();
    await isOn(page, true);
    await rowsAgree(page);
    await shot(page, `phone-${colorScheme}-on`);
    await context.close();
  }
}, 60_000);

test('a push shows as a notification with Archive and Mark read, and a tap opens its conversation in the open app', async () => {
  const { page, context } = await installed();
  await page.emulateMedia({ colorScheme: 'dark' });
  await shot(page, 'desktop-dark-off');
  const reader = page.locator('section[aria-label="Reader"] h1');
  // The conversation the notice is about, known by the address that opens it, once the address
  // has moved on from the newest, which the Inbox opened at. The next is a conversation too, where
  // further down lie the demo's GitHub bundles.
  const rows = page.getByRole('option');
  const newest = new URL(page.url()).searchParams.get('open');
  await rows.nth(1).click();
  const subject = await reader.textContent();
  await page.waitForURL((url) => ![null, newest].includes(url.searchParams.get('open')));
  const open = new URL(page.url()).searchParams.get('open')!;
  await rows.nth(0).click();
  await page.waitForFunction(
    (subject) => document.querySelector('section[aria-label="Reader"] h1')?.textContent !== subject,
    subject,
  );

  await recordShown(context);
  await push(page, context, {
    title: 'Ada Park',
    body: 'Trip photos\nHere are the ones from the ridge.',
    tag: open,
    navigate: addressOf({ view: { in: 'inbox' }, open }),
    message: { account: 'personal', path: 'INBOX', uidValidity: 1, uid: 1 },
  });
  const [shown] = await notifications(context);
  expect(shown).toEqual({
    title: 'Ada Park',
    options: {
      body: 'Trip photos\nHere are the ones from the ridge.',
      tag: open,
      lang: 'en',
      icon: '/icons/icon-192.png',
      data: {
        navigate: addressOf({ view: { in: 'inbox' }, open }),
        message: { account: 'personal', path: 'INBOX', uidValidity: 1, uid: 1 },
      },
      actions: [
        { action: 'archive', title: 'Archive' },
        { action: 'read', title: 'Mark read' },
      ],
    },
  });

  // The tap brings the open Trail Mix forward, on the conversation.
  await click(context, '');
  await page.waitForFunction(
    (subject) => document.querySelector('section[aria-label="Reader"] h1')?.textContent === subject,
    subject,
  );
  await page.waitForURL((url) => url.searchParams.get('open') === open);
}, 60_000);

test('Archive on a notification archives its message through the worker, and the app shows it gone', async () => {
  const { page, context } = await installed();
  // A message with an attachment names its ref in the link to it.
  const invoice = page.getByRole('option').filter({ hasText: 'Invoice for October' }).first();
  await invoice.click();
  const link = page.locator('section[aria-label="Reader"] a[href^="/messages/"]').first();
  const { ref } = readMessagePath(new URL((await link.getAttribute('href'))!, app.url).pathname)!;
  await page.getByRole('option').filter({ hasNotText: 'Invoice for October' }).first().click();

  await recordShown(context);
  await push(page, context, {
    title: 'Fieldnote Studio',
    body: 'Invoice for October',
    tag: 'invoice',
    navigate: '/',
    message: ref,
  });
  await notifications(context);
  await click(context, 'archive');
  await invoice.waitFor({ state: 'detached', timeout: 10_000 });
}, 60_000);

/** A push to the installed app's worker, as Chromium's DevTools sends one. */
async function push(page: Page, context: BrowserContext, notice: Notice) {
  const devtools = await context.newCDPSession(page);
  const registered = new Promise<string>((resolve) => {
    devtools.on('ServiceWorker.workerRegistrationUpdated', ({ registrations }) => {
      const live = registrations.find(({ isDeleted }) => !isDeleted);
      if (live) resolve(live.registrationId);
    });
  });
  await devtools.send('ServiceWorker.enable');
  await devtools.send('ServiceWorker.deliverPushMessage', {
    origin: new URL(app.url).origin,
    registrationId: await registered,
    data: JSON.stringify(pushOf(notice)),
  });
}

/** Has the worker record what it would show, since headless Chromium shows nothing. */
async function recordShown(context: BrowserContext) {
  const [worker] = context.serviceWorkers();
  await worker!.evaluate(() => {
    const scope = self as unknown as {
      shown: { title: string; options: object }[];
      registration: { showNotification: (title: string, options: object) => Promise<void> };
    };
    scope.shown = [];
    scope.registration.showNotification = (title, options) => {
      scope.shown.push({ title, options });
      return Promise.resolve();
    };
  });
}

/** What the worker has shown since it began recording, once it has shown something. */
async function notifications(context: BrowserContext) {
  const [worker] = context.serviceWorkers();
  for (let tries = 0; tries < 50; tries++) {
    const shown = await worker!.evaluate(
      () => (self as unknown as { shown: { title: string; options: object }[] }).shown,
    );
    if (shown.length > 0) return shown;
    await Bun.sleep(100);
  }
  return [];
}

/**
 * A tap on the notification the worker showed last, or one of its buttons, as the worker hears it.
 * Only the browser sends a trusted one, so this one carries what the worker reads of it.
 */
async function click(context: BrowserContext, action: string) {
  const [worker] = context.serviceWorkers();
  await worker!.evaluate((action) => {
    const scope = self as unknown as {
      shown: { options: { data: unknown } }[];
      dispatchEvent(event: Event): boolean;
    };
    const { data } = scope.shown.at(-1)!.options;
    const event = Object.assign(new Event('notificationclick'), {
      action,
      notification: { data, close: () => {} },
      waitUntil: (work: Promise<unknown>) => void work,
    });
    scope.dispatchEvent(event);
  }, action);
}

/**
 * Every row of Settings has one shape: its label, in one ink and size, and what it does on the
 * left, and its control on the right, where what each draws ends at the same edge. The page never
 * scrolls sideways for a target that reaches past it.
 */
async function rowsAgree(page: Page) {
  const rows = await page.getByRole('region', { name: 'Settings' }).evaluate((settings) =>
    ['Notifications on this device', 'Accent color'].map((name) => {
      const label = [...settings.querySelectorAll('label')].find(
        ({ textContent }) => textContent === name,
      )!;
      const { color, fontSize, fontWeight } = getComputedStyle(label);
      const words = label.parentElement!.getBoundingClientRect();
      const control = document.getElementById(label.htmlFor) as HTMLInputElement;
      // What each control draws: the switch's track, around its input, or the swatch beside the
      // picker.
      const drawn = control.type === 'color' ? control.nextElementSibling! : control.parentElement!;
      return {
        name,
        looks: `${color} ${fontSize} ${fontWeight}`,
        isControlRight: control.getBoundingClientRect().left >= words.right,
        drawnTo: drawn.getBoundingClientRect().right,
      };
    }),
  );
  expect(rows.map(({ name, isControlRight }) => ({ name, isControlRight }))).toEqual([
    { name: 'Notifications on this device', isControlRight: true },
    { name: 'Accent color', isControlRight: true },
  ]);
  expect(rows[0]!.looks).toBe(rows[1]!.looks);
  expect(Math.abs(rows[0]!.drawnTo - rows[1]!.drawnTo)).toBeLessThan(1);
  expect(
    await page.evaluate(() =>
      [...document.querySelectorAll('*')]
        .filter((element) => {
          const { overflowX } = getComputedStyle(element);
          return (
            (overflowX === 'auto' ||
              overflowX === 'scroll' ||
              element === document.documentElement) &&
            element.scrollWidth > element.clientWidth
          );
        })
        .map(({ tagName, className }) => `${tagName}.${String(className)}`),
    ),
  ).toEqual([]);
}

async function shot(page: Page, screen: string) {
  await page.screenshot({ path: join(SHOTS, `notifications-${screen}.png`) });
  expect({ screen, unusable: await unusable(page) }).toEqual({ screen, unusable: [] });
}

/** In the page: a PushManager that subscribes one device and keeps it in the page's storage. */
function standInPushManager(device: typeof DEVICE) {
  const KEPT = 'test.push-subscription';
  const subscriptionOf = (key: string) => ({
    endpoint: device.endpoint,
    options: { applicationServerKey: Uint8Array.from(atob(key), (c) => c.charCodeAt(0)).buffer },
    toJSON: () => device,
    unsubscribe: () => {
      localStorage.removeItem(KEPT);
      return Promise.resolve(true);
    },
  });
  PushManager.prototype.getSubscription = function () {
    const kept = localStorage.getItem(KEPT);
    const { key } = kept ? (JSON.parse(kept) as { key: string }) : { key: undefined };
    return Promise.resolve((key ? subscriptionOf(key) : null) as PushSubscription | null);
  };
  PushManager.prototype.subscribe = function (options?: PushSubscriptionOptionsInit) {
    const key = btoa(
      String.fromCharCode(...new Uint8Array(options!.applicationServerKey as ArrayBuffer)),
    );
    localStorage.setItem(KEPT, JSON.stringify({ key, endpoint: device.endpoint }));
    return Promise.resolve(subscriptionOf(key) as unknown as PushSubscription);
  };
}
