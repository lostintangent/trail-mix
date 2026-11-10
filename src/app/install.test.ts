import { expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { hexOf, parseColor } from '../shared/color.ts';
import { hashOf, ICON_FOLDER, ICONS, PUBLIC, readFavicon, SOURCE_HASH } from './icons.ts';
import { DESK, DESK_HEX, type Halves } from './theme/palette.ts';

type Manifest = {
  id: string;
  start_url: string;
  scope: string;
  display: string;
  name: string;
  background_color: string;
  theme_color: string;
  icons: { src: string; sizes: string; type: string; purpose: string }[];
};

const manifest = async () =>
  JSON.parse(await readFile(join(PUBLIC, 'manifest.webmanifest'), 'utf8')) as Manifest;

/** A PNG's width and height, from its header. */
async function sizeOf(file: string) {
  const header = new DataView((await readFile(file)).buffer);
  return { width: header.getUint32(16), height: header.getUint32(20) };
}

test('the manifest installs Trail Mix standalone, with everything it serves in scope', async () => {
  expect(await manifest()).toMatchObject({
    id: '/',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    name: 'Trail Mix',
  });
});

test('every icon the manifest names exists at the size it says, and so does the touch icon', async () => {
  const { icons } = await manifest();
  const named = icons.map(({ src }) => src.replace('/icons/', ''));
  expect(named).toEqual(
    ICONS.filter(({ file }) => file !== 'apple-touch-icon.png').map(({ file }) => file),
  );
  for (const { src, sizes, purpose } of icons) {
    const icon = ICONS.find(({ file }) => src === `/icons/${file}`)!;
    expect({ src, sizes, purpose }).toEqual({
      src,
      sizes: `${icon.size}x${icon.size}`,
      purpose: icon.isFullBleed ? 'maskable' : 'any',
    });
  }
  for (const { file, size } of ICONS) {
    expect({ file, ...(await sizeOf(join(ICON_FOLDER, file))) }).toEqual({
      file,
      width: size,
      height: size,
    });
  }
});

// Made with `bun run icons`, which records what it drew from.
test('the icons were drawn from today’s favicon and recipe', async () => {
  const committed = (await readFile(SOURCE_HASH, 'utf8')).trim();
  expect(committed).toBe(hashOf(await readFavicon()));
});

// The manifest and the theme-color metas can't read the theme, so they carry the desk as hex.
test('the browser’s chrome takes the desk’s colors in both themes', async () => {
  const desk: Halves = DESK_HEX;
  expect(desk).toEqual({
    light: hexOf(parseColor(DESK.light)!),
    dark: hexOf(parseColor(DESK.dark)!),
  });
  const { background_color, theme_color } = await manifest();
  expect({ background_color, theme_color }).toEqual({
    background_color: DESK_HEX.light,
    theme_color: DESK_HEX.light,
  });
});
