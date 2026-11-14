import { expect } from 'bun:test';
import { join } from 'node:path';
import type { Locator, Page } from 'playwright';
import { atRest } from '../atRest.ts';
import { RESULTS } from './suite.ts';

/**
 * Fails naming everything on `page` a member can't use, once it comes to rest, and leaves its
 * screenshot as `screen` in the folder CI uploads.
 */
export async function expectUsable(page: Page, screen: string) {
  const problems = await unusable(page);
  await page.screenshot({ path: join(RESULTS, `${screen}.png`) });
  expect({ screen, unusable: problems }).toEqual({ screen, unusable: [] });
}

/**
 * Everything on screen a member can't use, once it comes to rest: text whose contrast against what
 * lies behind it falls under 4.5:1 and, under a finger, a target under 44 pixels.
 */
export async function unusable(page: Page): Promise<string[]> {
  await atRest(page);
  return [
    ...(await textContrasts(page.locator('body')))
      .filter(({ ratio }) => ratio < 4.5)
      .map(({ text, ratio }) => `${ratio.toFixed(2)}:1 "${text.slice(0, 40)}"`),
    ...(await smallTargets(page)),
  ];
}

/**
 * Each control a tap can reach whose target is under 44 pixels either way, when the pointer is
 * coarse. A control's target is its label or, for a field, Astryx's box around it, which hands
 * every tap on it to the field. Astryx grows a control's own target toward 44 pixels in the frame
 * after it changes, so it is measured two frames on.
 */
function smallTargets(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    if (!matchMedia('(pointer: coarse)').matches) return [];
    await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
    const controls = document.querySelectorAll(
      'a[href], button, input, select, textarea, [role=button], [role=link], [role=switch], [role=checkbox], [role=radio], [role=tab], [role=option], [role=treeitem], [role=menuitem], [role=menuitemradio], [role=menuitemcheckbox]',
    );
    return [...controls].flatMap((control) => {
      if (control.closest('[inert]')) return [];
      const target = control.closest('label, .astryx-text-input') ?? control;
      const { left, top, width, height } = target.getBoundingClientRect();
      // Off screen, or under something else, nothing is tapped.
      const tapped = document.elementFromPoint(left + width / 2, top + height / 2);
      if (!tapped || !target.contains(tapped) || Math.min(width, height) >= 44) return [];
      const name = control.getAttribute('aria-label') ?? control.textContent ?? '';
      return [`${+width.toFixed(2)}×${+height.toFixed(2)} "${name.trim().slice(0, 40)}"`];
    });
  });
}

/** Each visible text node under `root`, in document order, with its contrast against what lies behind it. */
export function textContrasts(root: Locator): Promise<{ text: string; ratio: number }[]> {
  return root.evaluate((root) => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    const ink = canvas.getContext('2d', { willReadFrequently: true })!;
    const rgba = (css: string) => {
      ink.clearRect(0, 0, 1, 1);
      ink.fillStyle = css;
      ink.fillRect(0, 0, 1, 1);
      const [r = 0, g = 0, b = 0, a = 0] = ink.getImageData(0, 0, 1, 1).data;
      return [r, g, b, a / 255] as const;
    };
    type Color = readonly [number, number, number, number];
    const over = (top: Color, bottom: Color): Color => [
      top[0] * top[3] + bottom[0] * (1 - top[3]),
      top[1] * top[3] + bottom[1] * (1 - top[3]),
      top[2] * top[3] + bottom[2] * (1 - top[3]),
      1,
    ];
    const behind = (element: Element): Color => {
      const layers: Color[] = [];
      for (let node: Element | null = element; node; node = node.parentElement) {
        const color = rgba(getComputedStyle(node).backgroundColor);
        if (color[3] > 0) layers.push(color);
        if (color[3] >= 1) break;
      }
      return layers
        .reverse()
        .reduce<Color>((below, layer) => over(layer, below), [255, 255, 255, 1]);
    };
    const luminance = ([r, g, b]: Color) => {
      const linear = (v: number) =>
        (v /= 255) <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
      return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
    };
    const contrasts: { text: string; ratio: number }[] = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const element = node.parentElement;
      const text = node.textContent?.trim();
      if (!element || !text || element.closest('[inert], [aria-hidden="true"]')) continue;
      const box = element.getBoundingClientRect();
      if (!box.width || box.right < 0 || box.left > innerWidth) continue;
      const background = behind(element);
      const [lighter, darker] = [
        luminance(over(rgba(getComputedStyle(element).color), background)),
        luminance(background),
      ].sort((a, b) => b - a) as [number, number];
      contrasts.push({ text, ratio: (lighter + 0.05) / (darker + 0.05) });
    }
    return contrasts;
  });
}
