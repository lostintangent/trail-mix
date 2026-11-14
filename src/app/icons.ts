import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * The app's icons, made from `public/favicon.svg` into `public/icons/` by `bun run icons`, which
 * draws each in the Chromium that Playwright installs. The PNGs are committed beside a hash of the
 * drawings they came from, and a test fails when the favicon or this recipe has moved on without
 * them.
 */

export type Icon = {
  file: string;
  size: number;
  /** Fills the whole square, for a platform that cuts its own shape, rather than the favicon's. */
  isFullBleed: boolean;
  /** How large the mark is drawn on a full-bleed square. */
  scale: number;
};

export const ICONS: readonly Icon[] = [
  { file: 'icon-192.png', size: 192, isFullBleed: false, scale: 1 },
  { file: 'icon-512.png', size: 512, isFullBleed: false, scale: 1 },
  // A maskable icon may be cut to any shape inside its middle 80%, so the mark keeps clear of it.
  { file: 'maskable-512.png', size: 512, isFullBleed: true, scale: 0.8 },
  // iOS rounds the corners itself, and fills what is transparent with black.
  { file: 'apple-touch-icon.png', size: 180, isFullBleed: true, scale: 1 },
];

export const PUBLIC = join(import.meta.dir, '../../public');
export const ICON_FOLDER = join(PUBLIC, 'icons');
/** The hash of the drawings the committed PNGs came from, kept here so it isn't served. */
export const SOURCE_HASH = join(import.meta.dir, 'icons.sha256');

/** The favicon's background: a 32-unit square with rounded corners, in one color. */
const BACKGROUND = /<rect width="32" height="32" rx="[\d.]+" fill="([^"]+)"\/>/;

/** The drawing of one icon, as SVG. */
function drawingOf(favicon: string, { isFullBleed, scale }: Icon): string {
  if (!isFullBleed) return favicon.trim();
  const background = BACKGROUND.exec(favicon);
  if (!background) throw new Error('favicon.svg has no 32-unit background square to fill.');
  const mark = favicon
    .replace(background[0], '')
    .trim()
    .replace(/^<svg[^>]*>/, '')
    .replace(/<\/svg>$/, '');
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">` +
    `<rect width="32" height="32" fill="${background[1]}"/>` +
    `<g transform="translate(16 16) scale(${scale}) translate(-16 -16)">${mark}</g></svg>`
  );
}

/** One hash over every icon's drawing, which changes when the favicon or the recipe does. */
export function hashOf(favicon: string): string {
  const hash = createHash('sha256');
  for (const icon of ICONS) hash.update(`${icon.file}\n${drawingOf(favicon, icon)}\n`);
  return hash.digest('hex');
}

export async function readFavicon(): Promise<string> {
  return readFile(join(PUBLIC, 'favicon.svg'), 'utf8');
}

async function makeIcons() {
  const { chromium } = await import('playwright');
  const favicon = await readFavicon();
  await mkdir(ICON_FOLDER, { recursive: true });
  const browser = await chromium.launch();
  try {
    for (const icon of ICONS) {
      const page = await browser.newPage({
        viewport: { width: icon.size, height: icon.size },
        deviceScaleFactor: 1,
      });
      const source = `data:image/svg+xml;base64,${Buffer.from(drawingOf(favicon, icon)).toString('base64')}`;
      await page.setContent(
        `<body style="margin:0"><img src="${source}" width="${icon.size}" height="${icon.size}" style="display:block"></body>`,
      );
      await page.locator('img').evaluate((image: HTMLImageElement) => image.decode());
      await page.screenshot({ path: join(ICON_FOLDER, icon.file), omitBackground: true });
      await page.close();
    }
  } finally {
    await browser.close();
  }
  await writeFile(SOURCE_HASH, `${hashOf(favicon)}\n`);
}

if (import.meta.main) await makeIcons();
