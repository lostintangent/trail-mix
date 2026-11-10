import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { Browser, Page } from 'playwright';
import { READS, type Seen } from '../../src/features/reader/core/colors.ts';
import { contrast, oklchOf, over, parseHex, type Rgb } from '../../src/shared/color.ts';
import type { Result, Shown } from './harness/main.tsx';
import {
  BROWSERS,
  corpus,
  launch,
  serveCanary,
  serveHarness,
  type Canary,
  type Harness,
} from './browsers.ts';

/**
 * Mail on the theme's paper, in both themes, in real browsers. Each kind of mail is shown with the
 * system's color scheme set against the theme's, so whatever follows the theme can't be following
 * the system instead.
 */

/** One message of each kind, from the real-world corpus. */
const KINDS = {
  /** Colors its text and nothing else, as GitHub's notifications do. */
  github: 'github-notification.html',
  /** Sets black text on a white background, as Outlook's replies do. */
  outlook: 'outlook-mobile-reply.html',
  /** Colors its text with font tags, names and translucency, and pastes white backgrounds. */
  pasted: 'pasted-colors.html',
  /** Sets no color at all. */
  plain: 'plain-html.html',
  /** Declares a dark color scheme, in a meta and in CSS, with dark styles of its own. */
  ownDark: 'dark-scheme.html',
  /** The same, declared in its metas alone. */
  ownDarkMeta: 'dark-scheme.html',
  /** The same, declared in its CSS alone, after styles it would otherwise lift. */
  ownDarkCss: 'dark-scheme.html',
  /** Paints its own backgrounds. */
  painted: 'receipt.html',
  /** Colors its text, and asks for light paper only. */
  lightOnly: 'github-notification.html',
} as const;

type Kind = keyof typeof KINDS;
const kinds = Object.keys(KINDS) as Kind[];

/**
 * What a frame shows: its paper and ink, and every piece of text it shows, as the screen does, and
 * whether any color of the message's own was rewritten.
 */
type Shows = {
  paper: Rgb;
  ink: Rgb;
  texts: { text: string; color: Rgb; on: Rgb }[];
  rewritten: boolean;
};

let harness: Harness;
let canary: Canary;
let mail: Record<Kind, string>;

beforeAll(async () => {
  canary = serveCanary();
  harness = await serveHarness();
  const real = await corpus('real', canary);
  const html = (name: string) => real.find((file) => file.name === name)?.html ?? '';
  mail = Object.fromEntries(kinds.map((kind) => [kind, html(KINDS[kind])])) as Record<Kind, string>;
  mail.lightOnly = `<meta name="color-scheme" content="only light">${mail.lightOnly}`;
  mail.ownDarkMeta = mail.ownDark.replace(/:root \{[^}]*\}/, '');
  mail.ownDarkCss = mail.ownDark
    .replace(/<meta name="(color-scheme|supported-color-schemes)"[^>]*>/g, '')
    .replace(/(:root \{[^}]*\})([\s\S]*?)(\s*@media)/, '$2$1$3');
}, 60_000);

afterAll(() => {
  harness.stop();
  canary.stop();
});

for (const type of BROWSERS) {
  describe(type.name(), () => {
    let browser: Browser;
    const shown = {} as Record<'light' | 'dark', { results: Result[]; frames: Shows[] }>;
    const of = (theme: 'light' | 'dark', kind: Kind) => {
      const frame = shown[theme].frames[kinds.indexOf(kind)];
      if (!frame) throw new Error(`Nothing shown for ${kind}`);
      return frame;
    };

    beforeAll(async () => {
      browser = await launch(type);
      for (const theme of ['light', 'dark'] as const) {
        const page = await browser.newPage({ colorScheme: theme === 'dark' ? 'light' : 'dark' });
        const results = await show(
          page,
          theme,
          kinds.map((kind) => mail[kind]),
        );
        shown[theme] = { results, frames: await framesOf(page) };
        await page.close();
      }
    }, 60_000);
    afterAll(() => browser.close());

    test('in the light theme, every kind of mail shows its colors as written', () => {
      for (const kind of kinds) {
        const light = of('light', kind);
        expect(luminance(light.paper)).toBeGreaterThan(0.8);
      }
      const github = of('light', 'github');
      expect(colorOf(github, 'Reply to this email')).toEqual(hex('#666666'));
      expect(colorOf(github, '> +export function isLoop')).toEqual(hex('#555555'));
      expect(colorOf(of('light', 'pasted'), 'No dogs')).toEqual(hex('#ff0000'));
      expect(colorOf(of('light', 'outlook'), 'I know!!! The hut has room')).toEqual(hex('#000000'));
    });

    test('in the dark theme, mail that colors only its text sits on charcoal and reads at 4.5:1', () => {
      for (const kind of ['github', 'outlook', 'pasted', 'plain'] as const) {
        const dark = of('dark', kind);
        expect(shown.dark.results[kinds.indexOf(kind)]?.paper).toBe('theme');
        expect(luminance(dark.paper)).toBeLessThan(0.1);
        expect(dark.texts.length).toBeGreaterThan(0);
        expect(dark.rewritten).toBe(kind !== 'plain');
        for (const { text, color, on } of dark.texts) {
          expect({ text, reads: contrast(color, on) >= READS }).toEqual({ text, reads: true });
        }
      }
    });

    test('each color reads as strongly as it did on white, with its hue kept', () => {
      for (const kind of ['github', 'outlook', 'pasted'] as const) {
        const light = of('light', kind).texts;
        const dark = of('dark', kind);
        const strongest = contrast(dark.ink, dark.paper);
        expect(dark.texts.map(({ text }) => text)).toEqual(light.map(({ text }) => text));
        light.forEach(({ text, color, on }, index) => {
          const lifted = dark.texts[index];
          if (!lifted) throw new Error(`${text} isn't shown in the dark theme`);
          const wanted = Math.min(Math.max(contrast(color, on), READS), strongest);
          const reads = contrast(lifted.color, lifted.on);
          expect({ text, reads: reads >= wanted - 0.05 }).toEqual({ text, reads: true });
          const before = oklchOf(color);
          if (before.c > 0.05)
            expect(hueDistance(before.h, oklchOf(lifted.color).h)).toBeLessThan(4);
        });
      }
    });

    test('black and near-black text becomes the theme’s ink', () => {
      const outlook = of('dark', 'outlook');
      expect(colorOf(outlook, 'I know!!! The hut has room')).toEqual(outlook.ink);
      expect(colorOf(of('dark', 'pasted'), 'Bring a headlamp')).toEqual(of('dark', 'pasted').ink);
      expect(colorOf(of('dark', 'plain'), 'The cabin is booked')).toEqual(of('dark', 'plain').ink);
    });

    test('mail that declares a dark color scheme shows its own dark styles, by the theme', () => {
      for (const kind of ['ownDark', 'ownDarkMeta', 'ownDarkCss'] as const) {
        expect(shown.light.results[kinds.indexOf(kind)]?.paper).toBe('theme');
        const [light, dark] = [of('light', kind), of('dark', kind)];
        expect(colorOf(light, 'Permit 2026-0417')).toEqual(hex('#1d2420'));
        expect(backgroundOf(light, 'Permit 2026-0417')).toEqual(hex('#ffffff'));
        expect(colorOf(dark, 'Permit 2026-0417')).toEqual(hex('#e6ece8'));
        expect(backgroundOf(dark, 'Permit 2026-0417')).toEqual(hex('#1d2420'));
        expect(colorOf(dark, 'Show the permit')).toEqual(hex('#8fd3a8'));
        expect(dark.rewritten).toBe(false);
      }
    });

    test('mail that paints its own backgrounds, or asks for light only, stays on light paper', () => {
      for (const kind of ['painted', 'lightOnly'] as const) {
        expect(shown.dark.results[kinds.indexOf(kind)]?.paper).toBe('light');
        const [light, dark] = [of('light', kind), of('dark', kind)];
        expect(luminance(dark.paper)).toBeGreaterThan(0.8);
        expect(dark.paper).toEqual(light.paper);
        expect(dark.texts).toEqual(light.texts);
      }
    });

    test('switching the theme changes an open message at once, without sanitizing it again', async () => {
      const page = await browser.newPage({ colorScheme: 'dark' });
      await show(page, 'light', [mail.github, mail.pasted]);
      expect(await page.evaluate(() => window.sanitized)).toBe(2);
      const frames = await page.evaluate(
        () =>
          new Promise<number>((resolve) => {
            const footer = () => {
              const frame = document.querySelector<HTMLIFrameElement>('[data-mail="0"] iframe');
              const p = frame?.contentDocument?.querySelector('p[style*="small"]');
              return p ? getComputedStyle(p).color : '';
            };
            const before = footer();
            window.setTheme('dark');
            let count = 0;
            const check = () => {
              count++;
              if (footer() !== before || count > 30) resolve(count);
              else requestAnimationFrame(check);
            };
            requestAnimationFrame(check);
          }),
      );
      expect(frames).toBeLessThanOrEqual(2);
      await page.waitForFunction(
        () =>
          [...document.querySelectorAll('iframe')].filter(
            (frame) => frame.style.visibility === 'visible',
          ).length === 2,
      );
      expect(await page.evaluate(() => window.sanitized)).toBe(2);
      const switched = await framesOf(page);
      expect(switched[0]).toEqual(of('dark', 'github'));
      expect(switched[1]).toEqual(of('dark', 'pasted'));
      await page.close();
    });
  });
}

/** Shows messages in the harness under a theme, and waits until every frame is sized. */
async function show(page: Page, theme: 'light' | 'dark', html: string[]): Promise<Result[]> {
  await page.goto(harness.origin);
  await page.evaluate((mode) => window.setTheme(mode), theme);
  const mails: Shown[] = html.map((one) => ({ html: one, images: 'blocked' }));
  const results = await page.evaluate((all) => window.show(all), mails);
  await page.waitForFunction(
    (count) =>
      [...document.querySelectorAll('iframe')].filter(
        (frame) => frame.style.visibility === 'visible',
      ).length === count,
    html.length,
  );
  return results;
}

/**
 * Every frame's paper and ink, and each piece of text it shows: its color, and what it lies on,
 * through every translucent background down to an opaque one. Each color is read as a screen shows
 * it, by drawing it.
 */
async function framesOf(page: Page): Promise<Shows[]> {
  const written = await page.evaluate(() => {
    const context = new OffscreenCanvas(1, 1).getContext('2d', { willReadFrequently: true });
    const drawn = (css: string): number[] => {
      if (!context) return [];
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = css;
      context.fillRect(0, 0, 1, 1);
      return [...context.getImageData(0, 0, 1, 1).data];
    };
    return [...document.querySelectorAll<HTMLIFrameElement>('[data-mail] iframe')].map((frame) => {
      const document = frame.contentDocument;
      const view = document?.defaultView;
      if (!document || !view) return { paper: [], ink: [], texts: [], rewritten: false };
      const root = view.getComputedStyle(document.documentElement);
      const texts: { text: string; color: number[]; on: number[][] }[] = [];
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const text = node.textContent?.trim();
        const element = node.parentElement;
        if (!text || !element || element.closest('style, script, title')) continue;
        if (!element.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue;
        const style = view.getComputedStyle(element);
        if (parseFloat(style.fontSize) === 0) continue;
        const on: number[][] = [];
        for (let at: Element | null = element; at; at = at.parentElement) {
          const background = drawn(view.getComputedStyle(at).backgroundColor);
          on.push(background);
          if (background[3] === 255) break;
        }
        texts.push({ text: text.slice(0, 40), color: drawn(style.webkitTextFillColor), on });
      }
      const rewritten = [...document.body.querySelectorAll('style, [style]')].some((element) =>
        /light-dark\(/.test(element.outerHTML),
      );
      return { paper: drawn(root.backgroundColor), ink: drawn(root.color), texts, rewritten };
    });
  });
  return written.map(({ paper, ink, texts, rewritten }) => ({
    rewritten,
    paper: seenOf(paper).rgb,
    ink: seenOf(ink).rgb,
    texts: texts.map(({ text, color, on }) => {
      const under = on.map(seenOf).reduceRight<Rgb>((below, layer) => layered(layer, below), white);
      return { text, color: layered(seenOf(color), under), on: under };
    }),
  }));
}

const white: Rgb = { r: 1, g: 1, b: 1 };

function seenOf([r = 0, g = 0, b = 0, alpha = 0]: number[]): Seen {
  return { rgb: { r: r / 255, g: g / 255, b: b / 255 }, alpha: alpha / 255 };
}

const layered = ({ rgb, alpha }: Seen, under: Rgb): Rgb =>
  alpha >= 1 ? rgb : over(rgb, alpha, under);

const hex = (css: string) => {
  const rgb = parseHex(css);
  if (!rgb) throw new Error(`${css} is no #rrggbb`);
  return rgb;
};

function find(frame: Shows, start: string) {
  const found = frame.texts.find(({ text }) => text.startsWith(start));
  if (!found) throw new Error(`No text starts "${start}"`);
  return found;
}

const colorOf = (frame: Shows, start: string) => find(frame, start).color;
const backgroundOf = (frame: Shows, start: string) => find(frame, start).on;

const luminance = (color: Rgb) => (contrast(color, { r: 0, g: 0, b: 0 }) - 1) / 20;

function hueDistance(a: number, b: number) {
  const distance = Math.abs(a - b) % 360;
  return Math.min(distance, 360 - distance);
}
