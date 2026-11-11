import type { KeyboardEvent } from 'react';

/**
 * The sidebar's tree from the keyboard, as one Tab stop. Tab enters it on the line that lifts, the
 * view's or the one folded around it, or on its first line when none does, and leaves it again from
 * any line. Inside, the arrow keys move through the lines shown and fold and unfold them, Home and
 * End reach its ends, Enter opens a line, and Shift+F10 opens a line's menu. Every line keeps its
 * buttons, so a screen reader and a pointer still reach each one: the keys only spare a keyboard
 * fifty stops on its way to the list.
 *
 * Its elements carry marks the keys read: a row is a line's button that opens or folds it, with its
 * level as `data-row`, the one row in the Tab order has a `tabIndex` of 0, a line holding a row
 * with its chevron and menu is `data-line`, and the control that folds a line is `data-fold`, with
 * whether it's open as `aria-expanded`.
 */

/** The keys that move through the tree, which it keeps from scrolling the sidebar. */
const MOVES = /^(Arrow(Up|Down|Left|Right)|Home|End)$/;

/** What the moves do, loaded as they're first asked for. */
const loadMoves = () => (moves ??= import('./treeMoves.ts'));
let moves: Promise<typeof import('./treeMoves.ts')> | undefined;

/** The tree's keys, for the element that holds it. */
export function onTreeKey(event: KeyboardEvent<HTMLElement>) {
  const tree = event.currentTarget;
  if (!(event.target instanceof Element && rowOf(event.target))) return;
  // Tab leaves from the tree's stop, whichever line has focus, so it steps out of the tree.
  if (event.key === 'Tab') {
    tree.querySelector<HTMLElement>('[data-row][tabindex="0"]')?.focus({ preventScroll: true });
    return;
  }
  if (!MOVES.test(event.key)) return;
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
  event.preventDefault();
  void loadMoves().then(({ moveInTree }) => moveInTree(tree, event.key));
}

/** Loads the moves ahead of the first key, as the tree first takes focus. */
export const preloadTreeMoves = () => void loadMoves();

/** The row of the line an element sits in, unless it's in a menu over that line. */
export function rowOf(element: Element): HTMLElement | null | undefined {
  if (element.closest('[role="menu"]')) return undefined;
  return (
    element.closest<HTMLElement>('[data-row]') ??
    element.closest('[data-line]')?.querySelector<HTMLElement>('[data-row]')
  );
}
