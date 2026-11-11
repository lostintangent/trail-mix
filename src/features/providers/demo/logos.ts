/**
 * The demo mailbox's brands and their logos, which it brings with it rather than looking any up. Its
 * mail from these domains counts as verified, as a real server would find it. Each logo is drawn
 * from shapes alone, as a brand's BIMI logo is: no text, script or outside reference.
 */
export const DEMO_LOGOS: Readonly<Record<string, string>> = {
  'kernelweekly.example.com': logo(
    '#1d2b53',
    '<path d="M20 18v28M20 32l16-14M24 30l14 16" stroke="#fff" stroke-width="6" stroke-linecap="round" stroke-linejoin="round" fill="none"/>',
  ),
  'fieldnote.example.com': logo(
    '#2f6b4f',
    '<path d="M18 44c0-16 10-26 28-26 0 18-10 28-26 28" fill="#d8efe2"/><path d="M20 44l16-16" stroke="#2f6b4f" stroke-width="3" stroke-linecap="round"/>',
  ),
  'shop.example.com': logo(
    '#e2632b',
    '<path d="M18 26h28l-3 20H21z" fill="#fff"/><path d="M25 26v-3a7 7 0 0 1 14 0v3" stroke="#fff" stroke-width="4" fill="none"/>',
  ),
  'parcel-delivery.example.net': logo(
    '#7a5230',
    '<path d="M16 24l16-8 16 8v18l-16 8-16-8z" fill="#f2d9a8"/><path d="M16 24l16 8 16-8M32 32v18" stroke="#7a5230" stroke-width="3" fill="none"/>',
  ),
};

function logo(background: string, mark: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" version="1.2" baseProfile="tiny-ps" viewBox="0 0 64 64"><title>Logo</title><rect width="64" height="64" fill="${background}"/>${mark}</svg>`;
}
