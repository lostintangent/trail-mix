import type { Locator, Page } from 'playwright';

/**
 * Waits until nothing on a page, or in one element and what it holds, is moving, so what a test
 * reads or shoots is where it comes to rest. It looks again each frame rather than awaiting each
 * animation's `finished`, which rejects when the animation is cancelled, as one is when a pane is
 * swapped mid-slide, and a transition sent somewhere new is a new animation. An endless animation,
 * such as the airmail stripe or a skeleton's pulse, never rests, so it isn't waited for.
 */
export async function atRest(on: Page | Locator): Promise<void> {
  await ('goto' in on ? on.locator(':root') : on).evaluate(
    (root) =>
      new Promise<void>((done) => {
        const look = () => {
          const isMoving = root
            .getAnimations({ subtree: true })
            .some(
              ({ playState, effect }) =>
                playState === 'running' && effect?.getTiming().iterations !== Infinity,
            );
          if (isMoving) requestAnimationFrame(look);
          else done();
        };
        look();
      }),
  );
}
