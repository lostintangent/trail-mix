import { seededRandom } from '../../../shared/random.ts';
import { KERNEL_MARK } from './pictures.ts';

/**
 * Kernel Weekly's pictures: the masthead of the demo's newsletter and a figure for each of its
 * articles. A deployment of the demo mailbox serves them in place of the image proxy, so a visitor
 * who shows the newsletter's images sees real pictures and no request leaves Cloudflare. Each is an
 * SVG drawn from shapes and the newsletter's name, with nothing that runs or reaches outside
 * itself, and an address always draws the same picture. Any other address, the open pixel's
 * included, has none.
 */

export const MASTHEAD = 'https://kernelweekly.example.com/masthead.svg';

/** How many of each figure there are, so an issue's many articles ask for only a few pictures. */
const VARIANTS = 4;

/** The address of an article's figure: what it shows, and which of its variants the article has. */
export const figureAt = (figure: Figure, article: number) =>
  `https://kernelweekly.example.com/img/${figure}-${article % VARIANTS}.svg`;

/** The picture at an address, as an SVG document, or undefined where the demo has none. */
export function demoImage(address: string): string | undefined {
  if (address === MASTHEAD) return masthead();
  const [, name = '', variant = ''] =
    /^https:\/\/kernelweekly\.example\.com\/img\/([a-z]+)-(\d)\.svg$/.exec(address) ?? [];
  if (!Object.hasOwn(FIGURES, name) || Number(variant) >= VARIANTS) return undefined;
  const seed = Object.keys(FIGURES).indexOf(name) * VARIANTS + Number(variant) + 1;
  return picture(160, 100, FIGURES[name as Figure](seededRandom(seed)));
}

/** The newsletter's name and its K on its own navy, over a trace's bars and an amber rule. */
function masthead(): string {
  const random = seededRandom(212);
  const bars = Array.from({ length: 20 }, (_, k) => {
    const height = n(14 + random() * 64);
    return `<rect x="${478 + k * 7}" y="${n(128 - height)}" width="5" height="${height}" rx="1" fill="#2b3d73"/>`;
  });
  return picture(
    640,
    140,
    `<rect width="640" height="140" fill="#1d2b53"/>${bars.join('')}<rect y="132" width="640" height="8" fill="#e0a33a"/>` +
      `<g transform="translate(36 34) scale(1.125)"><rect width="64" height="64" rx="12" fill="#fdf6e3"/><path d="${KERNEL_MARK}" stroke="#1d2b53" stroke-width="6" stroke-linecap="round" stroke-linejoin="round" fill="none"/></g>` +
      // Lengths fixed, so a machine without Georgia sets the name in the same space.
      `<text x="132" y="78" textLength="318" lengthAdjust="spacingAndGlyphs" font-family="Georgia,'Times New Roman',serif" font-size="44" font-weight="700" fill="#fdf6e3">Kernel Weekly</text>` +
      `<text x="134" y="104" textLength="206" lengthAdjust="spacingAndGlyphs" font-family="Helvetica,Arial,sans-serif" font-size="13" font-weight="700" fill="#a9b8dc">SYSTEMS, EVERY FRIDAY</text>`,
  );
}

/** What each figure draws on its 160 by 100 picture, varied by its seed. */
const FIGURES = {
  /** A phone keeps its connection to a server as it moves from Wi-Fi to cellular. */
  migration: () =>
    `<rect width="160" height="100" fill="#e6eef7"/>` +
    `<rect x="14" y="28" width="26" height="44" rx="5" fill="#1d2b53"/><rect x="17" y="33" width="20" height="32" rx="2" fill="#8fb3e0"/>` +
    `<rect x="120" y="26" width="26" height="48" rx="3" fill="#1d2b53"/><path d="M125 38h16M125 50h16M125 62h16" stroke="#8fb3e0" stroke-width="3" stroke-linecap="round"/>` +
    `<path d="M42 42C62 22 98 22 118 42" fill="none" stroke="#9aa9bd" stroke-width="2.5" stroke-dasharray="5 4"/>` +
    `<path d="M70 14a14 14 0 0 1 20 0M74 18a8 8 0 0 1 12 0" fill="none" stroke="#9aa9bd" stroke-width="2.5" stroke-linecap="round"/>` +
    `<path d="M42 58C62 78 98 78 118 58M109 58h9v9" fill="none" stroke="#2a5d8f" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>` +
    `<path d="M80 79l-7 15h14z" fill="#2a5d8f"/>`,

  /** A congestion window: slow start doubles it, then each loss halves it and it grows back. */
  congestion: (random) => {
    const line = ['16,84', '20,82', '24,78', '28,70', '32,54', '36,22'];
    // The window's height over the axis, halved by the loss that ended slow start.
    let x = 36;
    let size = 32;
    line.push(`36,${86 - size}`);
    while (x < 146) {
      const end = Math.min(146, x + 18 + random() * 16);
      size += (end - x) * 0.75;
      x = end;
      line.push(`${n(x)},${n(86 - size)}`);
      if (x === 146) break;
      size /= 2;
      line.push(`${n(x)},${n(86 - size)}`);
    }
    const points = line.join(' ');
    return (
      `<rect width="160" height="100" fill="#fbf1e1"/><path d="M16 30h132M16 54h132" stroke="#ecd9b8" stroke-dasharray="3 3"/>` +
      `<polygon points="16,86 ${points} ${n(x)},86" fill="#f5c9b5"/>` +
      `<polyline points="${points}" fill="none" stroke="#d9634c" stroke-width="2.5" stroke-linejoin="round"/>` +
      `<path d="M16 12v74h132" fill="none" stroke="#8a7a5c" stroke-width="1.5"/>`
    );
  },

  /** A flame graph: each frame stands on the one that called it, as wide as its time. */
  flame: (random) => {
    const frames: string[] = [];
    const frame = (x: number, width: number, depth: number) => {
      frames.push(
        `<rect x="${n(x)}" y="${77 - depth * 13}" width="${n(width - 1)}" height="12" rx="2" fill="${pick(random, ['#e35d3a', '#e8743b', '#f0a04b', '#f6c065'])}"/>`,
      );
      if (depth === 5 || width < 10) return;
      const end = x + width * (0.7 + random() * 0.3);
      for (let at = x; at < end - 4;) {
        const child = Math.min(end - at, width * (0.3 + random() * 0.5));
        frame(at, child, depth + 1);
        at += child;
      }
    };
    frame(8, 144, 0);
    return `<rect width="160" height="100" fill="#fff4e6"/>${frames.join('')}`;
  },

  /** A terminal of indented code. */
  terminal: (random) => {
    let code = '';
    for (let row = 0, indent = 0; row < 6; row++) {
      for (let x = 12 + indent * 8, words = 1 + Math.floor(random() * 3); words > 0; words--) {
        const width = n(10 + random() * 30);
        if (x + width > 148) break;
        code += `<rect x="${n(x)}" y="${24 + row * 11}" width="${width}" height="5" rx="2.5" fill="${pick(random, ['#8fb3e0', '#e0a33a', '#9fd3a0', '#cbd5e1', '#d98ca6'])}"/>`;
        x += width + 5;
      }
      indent = Math.max(0, Math.min(3, indent + Math.floor(random() * 3) - 1));
    }
    return (
      `<rect width="160" height="100" fill="#1d2b3a"/><rect width="160" height="15" fill="#2a3b4f"/>` +
      `<circle cx="10" cy="7.5" r="3" fill="#e0685c"/><circle cx="20" cy="7.5" r="3" fill="#e0b94b"/><circle cx="30" cy="7.5" r="3" fill="#6cbf72"/>` +
      `${code}<rect x="12" y="88" width="6" height="6" fill="#cbd5e1"/>`
    );
  },

  /** Latencies with a long tail, past a dashed 99th percentile. */
  latency: (random) => {
    const peak = Math.log(4 + random() * 3);
    const tail = 17 + Math.floor(random() * 3);
    let bars = '';
    for (let k = 0; k < 22; k++) {
      const height = n(
        4 + 66 * Math.exp(-((Math.log(k + 1) - peak) ** 2) / 0.5) * (0.85 + random() * 0.3),
      );
      bars += `<rect x="${n(12 + k * 6.3)}" y="${n(86 - height)}" width="5" height="${height}" fill="${k < tail ? '#2f8f83' : '#d9634c'}"/>`;
    }
    return (
      `<rect width="160" height="100" fill="#e8f2ee"/>${bars}` +
      `<path d="M${n(10.5 + tail * 6.3)} 8v78" stroke="#d9634c" stroke-width="1.5" stroke-dasharray="3 3"/>` +
      `<path d="M8 86.5h144" stroke="#7d9a90" stroke-width="1.5"/>`
    );
  },

  /** Four CPUs' lanes, each running tasks in turn with idle gaps between. */
  lanes: (random) => {
    let runs = '';
    for (let lane = 0; lane < 4; lane++) {
      for (let x = 12 + random() * 6; x < 146;) {
        const width = Math.min(148 - x, 8 + random() * 26);
        runs += `<rect x="${n(x)}" y="${14 + lane * 20}" width="${n(width)}" height="12" rx="2" fill="${pick(random, ['#2a5d8f', '#e0a33a', '#2f8f83', '#d9634c', '#7b6bb0'])}"/>`;
        x += width + 2 + random() * 10;
      }
    }
    return `<rect width="160" height="100" fill="#eef0f6"/><path d="M12 20h136M12 40h136M12 60h136M12 80h136" stroke="#dde2ee" stroke-width="12"/>${runs}`;
  },

  /** Page tables: a walk from the root table to one page, its path in amber. */
  tree: (random) => {
    const walked = Math.floor(random() * 6);
    const middles = [30, 80, 130];
    const leaves = middles.flatMap((x) => [x - 13, x + 13]);
    const ink = (isWalked: boolean, otherwise: string) => (isWalked ? '#e0a33a' : otherwise);
    const line = (from: string, isWalked: boolean) =>
      `<path d="${from}" stroke="${ink(isWalked, '#b9b0d6')}" stroke-width="${isWalked ? 2.5 : 1.5}"/>`;
    return (
      `<rect width="160" height="100" fill="#f1eef8"/>` +
      middles.map((x, at) => line(`M80 24L${x} 43`, at === walked >> 1)).join('') +
      leaves.map((x, at) => line(`M${middles[at >> 1]} 57L${x} 77`, at === walked)).join('') +
      `<rect x="64" y="10" width="32" height="14" rx="3" fill="#5a4b8a"/>` +
      middles
        .map(
          (x, at) =>
            `<rect x="${x - 15}" y="43" width="30" height="14" rx="3" fill="${ink(at === walked >> 1, '#7b6bb0')}"/>`,
        )
        .join('') +
      leaves
        .map(
          (x, at) =>
            `<rect x="${x - 10}" y="77" width="20" height="12" rx="3" fill="${ink(at === walked, '#c9c1e6')}"/>`,
        )
        .join('')
    );
  },

  /** A heap's pages: used, freed but kept, and free. */
  memory: (random) => {
    let cells = '';
    for (let row = 0; row < 6; row++) {
      for (let column = 0; column < 12; column++) {
        const roll = random();
        const look =
          roll < 0.45
            ? 'fill="#c46a3f"'
            : roll < 0.75
              ? 'fill="#ecc9a8"'
              : 'fill="#fffaf3" stroke="#d9c9b3"';
        cells += `<rect x="${9.5 + column * 12}" y="${15.5 + row * 12}" width="9" height="9" rx="2" ${look}/>`;
      }
    }
    return `<rect width="160" height="100" fill="#f5eee4"/>${cells}`;
  },
} satisfies Record<string, (random: () => number) => string>;

export type Figure = keyof typeof FIGURES;

function picture(width: number, height: number, body: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${body}</svg>`;
}

function pick<T>(random: () => number, items: readonly T[]): T {
  return items[Math.floor(random() * items.length)]!;
}

/** A coordinate to a tenth, so a picture's text stays short. */
const n = (value: number) => Math.round(value * 10) / 10;
