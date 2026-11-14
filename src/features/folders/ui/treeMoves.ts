/**
 * What the tree's keys do, which loads apart from the first screen, as the tree first takes focus:
 * the arrow keys move through the lines shown and fold and unfold them, and Home and End reach its
 * ends. `treeKeys.ts` names the marks they read.
 */

/** A line of the tree as its keys see it: how deep it sits, and whether it's open, if it folds. */
export type TreeLine = { level: number; isOpen?: boolean | undefined };

/** What a key does in the tree: moves to another line, or folds or unfolds the line it's on. */
type TreeMove = { focus: number } | { fold: true };

/** What `key` does on the line at `at`, or nothing if it does nothing there. */
export function treeMove(
  lines: readonly TreeLine[],
  at: number,
  key: string,
): TreeMove | undefined {
  const line = lines[at];
  if (!line) return undefined;
  const to = (index: number) =>
    index >= 0 && index < lines.length && index !== at ? { focus: index } : undefined;
  switch (key) {
    case 'ArrowDown':
      return to(at + 1);
    case 'ArrowUp':
      return to(at - 1);
    case 'Home':
      return to(0);
    case 'End':
      return to(lines.length - 1);
    // Right unfolds a line, then steps inside it. Left folds it, then steps out to what holds it.
    case 'ArrowRight':
      if (line.isOpen === false) return { fold: true };
      return line.isOpen && (lines[at + 1]?.level ?? 0) > line.level ? to(at + 1) : undefined;
    case 'ArrowLeft':
      if (line.isOpen) return { fold: true };
      return to(lines.slice(0, at).findLastIndex(({ level }) => level < line.level));
    default:
      return undefined;
  }
}

/**
 * Does what `key` asks of the line with focus in `tree`, once loaded, by when an earlier key may
 * have moved it.
 */
export function moveInTree(tree: HTMLElement, key: string) {
  const rows = [...tree.querySelectorAll<HTMLElement>('[data-row]')].filter(
    (row) => !row.closest('[inert]'),
  );
  // A line's chevron or menu button stands for its row.
  const focused = document.activeElement;
  const row = focused?.closest('[data-line]')?.querySelector('[data-row]') ?? focused;
  const at = rows.findIndex((each) => each === row);
  const move = treeMove(rows.map(lineOf), at, key);
  if (move && 'focus' in move) rows[move.focus]?.focus();
  else if (move) foldOf(rows[at]!)?.click();
}

function lineOf(row: HTMLElement): TreeLine {
  const fold = foldOf(row);
  return {
    level: Number(row.dataset['row']),
    isOpen: fold && fold.getAttribute('aria-expanded') === 'true',
  };
}

const foldOf = (row: HTMLElement) =>
  row.closest('[data-line]')?.querySelector<HTMLElement>('[data-fold]') ?? undefined;
