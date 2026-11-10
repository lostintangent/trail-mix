/**
 * Where a phone's sheet can lie while the on-screen keyboard is up. A sheet fixed to the bottom of
 * the page lies behind the keyboard, which covers the page rather than shrinking it, and the
 * browser may scroll the page to keep the cursor in view. The visual viewport is the part still
 * seen, so the sheet keeps to it: its top moves down by however far the page scrolled, and its
 * bottom rises above the keyboard. A pinch zoom shrinks the visual viewport too, but then the
 * member is looking closer, not typing, so the sheet stays where it is.
 */
export type VisualViewport = { offsetTop: number; height: number; scale: number };

export type Band = { top: number; bottom: number };

export function visibleBand(layoutHeight: number, viewport: VisualViewport): Band {
  if (Math.abs(viewport.scale - 1) > 0.01) return { top: 0, bottom: 0 };
  const top = Math.max(0, Math.round(viewport.offsetTop));
  const bottom = Math.max(0, Math.round(layoutHeight - viewport.offsetTop - viewport.height));
  return { top, bottom };
}
