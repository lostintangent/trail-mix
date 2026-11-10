import type { Page } from 'playwright';

/** Every visible text node whose contrast against what lies behind it falls under 4.5:1. */
export function unreadableText(page: Page): Promise<string[]> {
  return page.evaluate(() => {
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
    const unreadable: string[] = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
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
      const ratio = (lighter + 0.05) / (darker + 0.05);
      if (ratio < 4.5) unreadable.push(`${ratio.toFixed(2)}:1 "${text.slice(0, 40)}"`);
    }
    return unreadable;
  });
}
