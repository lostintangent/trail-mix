/** How long to wait for a frame in a tab that draws none, as one in the background. */
const NO_FRAME_MS = 100;

/**
 * Resolves once the browser has painted the frame it is drawing now, so work that needn't show in
 * it, such as telling a server, doesn't hold it up. A hidden tab draws no frames, so it resolves
 * after a moment anyway.
 */
export function afterPaint(): Promise<void> {
  return new Promise((resolve) => {
    const anyway = setTimeout(resolve, NO_FRAME_MS);
    requestAnimationFrame(() =>
      setTimeout(() => {
        clearTimeout(anyway);
        resolve();
      }),
    );
  });
}
