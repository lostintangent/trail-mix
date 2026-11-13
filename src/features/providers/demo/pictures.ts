import { domainOf } from '../../mail/core/index.ts';

/** Kernel Weekly's K, in a 64-unit square, which its logo and its newsletter's masthead carry. */
export const KERNEL_MARK = 'M20 18v28M20 32l16-14M24 30l14 16';

/**
 * The demo mailbox's pictures, which it brings with it rather than looking any up: its brands'
 * logos, as their BIMI records would name them, one brand's site icon, and two people's photos, as
 * Gravatar would keep them. Its mail from these brands and people counts as verified, as a real
 * server would find it. Each is drawn from shapes alone: no text, script or outside reference.
 */
export const DEMO_PICTURES: {
  logos: Readonly<Record<string, string>>;
  icons: Readonly<Record<string, string>>;
  photos: Readonly<Record<string, string>>;
} = {
  logos: {
    'kernelweekly.example.com': logo(
      '#1d2b53',
      `<path d="${KERNEL_MARK}" stroke="#fff" stroke-width="6" stroke-linecap="round" stroke-linejoin="round" fill="none"/>`,
    ),
    'shop.example.com': logo(
      '#e2632b',
      '<path d="M18 26h28l-3 20H21z" fill="#fff"/><path d="M25 26v-3a7 7 0 0 1 14 0v3" stroke="#fff" stroke-width="4" fill="none"/>',
    ),
    'parcel-delivery.example.net': logo(
      '#7a5230',
      '<path d="M16 24l16-8 16 8v18l-16 8-16-8z" fill="#f2d9a8"/><path d="M16 24l16 8 16-8M32 32v18" stroke="#7a5230" stroke-width="3" fill="none"/>',
    ),
  },
  icons: {
    // A site's icon, drawn on nothing, as most are.
    'fieldnote.example.com': svg(
      '<path d="M16 46c0-18 11-29 32-29 0 21-11 31-29 31" fill="#2f6b4f"/><path d="M19 45l17-17" stroke="#d8efe2" stroke-width="3" stroke-linecap="round"/>',
    ),
  },
  photos: {
    'ada@example.com': portrait({
      background: '#bcd3e6',
      shirt: '#2d4f7c',
      skin: '#eac09a',
      hair: '#2a1f1a',
      fringe: 'M21 28c1-9 6-13 12-13 7 0 11 5 11 12-6-1-10-4-12-8-2 5-6 8-11 9z',
    }),
    'sofia@example.com': portrait({
      background: '#efd2bd',
      shirt: '#3f6b55',
      skin: '#b98262',
      hair: '#4a2c1d',
      fringe: 'M20 31c-2-10 4-17 12-17s14 6 12 17c-3-5-7-9-12-9s-9 4-12 9z',
    }),
  },
};

/** Whether the demo's mail from an address counts as verified: its brand or person has a picture. */
export function isDemoVerified(address: string): boolean {
  const domain = domainOf(address);
  return (
    domain in DEMO_PICTURES.logos ||
    domain in DEMO_PICTURES.icons ||
    address.toLowerCase() in DEMO_PICTURES.photos
  );
}

function svg(content: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">${content}</svg>`;
}

function logo(background: string, mark: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" version="1.2" baseProfile="tiny-ps" viewBox="0 0 64 64"><title>Logo</title><rect width="64" height="64" fill="${background}"/>${mark}</svg>`;
}

/** A head and shoulders, as a photo would frame them. */
function portrait(colors: {
  background: string;
  shirt: string;
  skin: string;
  hair: string;
  fringe: string;
}): string {
  return svg(
    `<rect width="64" height="64" fill="${colors.background}"/>` +
      `<path d="M20 32c0-12 5-19 12-19s12 7 12 19c0 6-1 11-3 13H23c-2-2-3-7-3-13z" fill="${colors.hair}"/>` +
      `<path d="M9 64c2-12 11-18 23-18s21 6 23 18z" fill="${colors.shirt}"/>` +
      `<path d="M27 40h10v6a5 5 0 0 1-10 0z" fill="${colors.skin}"/>` +
      `<ellipse cx="32" cy="30" rx="10" ry="12" fill="${colors.skin}"/>` +
      `<path d="${colors.fringe}" fill="${colors.hair}"/>`,
  );
}
