import { expect, test } from 'bun:test';
import { treeMove, type TreeLine } from './treeMoves.ts';

// The lines a sidebar shows: two unified views, an open account with an open folder inside it, and
// a folded account.
const LINES: (TreeLine & { name: string })[] = [
  { name: 'Inbox', level: 1 },
  { name: 'Flagged', level: 1 },
  { name: 'Personal', level: 1, isOpen: true },
  { name: 'Personal Inbox', level: 2 },
  { name: 'Projects', level: 2, isOpen: true },
  { name: 'Toy Box', level: 3 },
  { name: 'Trash', level: 2 },
  { name: 'Work', level: 1, isOpen: false },
];

const at = (name: string) => LINES.findIndex((line) => line.name === name);
const press = (name: string, key: string) => {
  const move = treeMove(LINES, at(name), key);
  return move && 'focus' in move ? LINES[move.focus]!.name : move;
};

test('the up and down arrows step through the lines shown, and stop at either end', () => {
  expect(press('Flagged', 'ArrowDown')).toBe('Personal');
  expect(press('Projects', 'ArrowDown')).toBe('Toy Box');
  expect(press('Toy Box', 'ArrowUp')).toBe('Projects');
  expect(press('Inbox', 'ArrowUp')).toBeUndefined();
  expect(press('Work', 'ArrowDown')).toBeUndefined();
});

test('Home and End reach the first and last lines', () => {
  expect(press('Toy Box', 'Home')).toBe('Inbox');
  expect(press('Toy Box', 'End')).toBe('Work');
  expect(press('Inbox', 'Home')).toBeUndefined();
});

test('the right arrow unfolds a folded line, then steps inside an open one', () => {
  expect(press('Work', 'ArrowRight')).toEqual({ fold: true });
  expect(press('Personal', 'ArrowRight')).toBe('Personal Inbox');
  expect(press('Projects', 'ArrowRight')).toBe('Toy Box');
  expect(press('Toy Box', 'ArrowRight')).toBeUndefined();
  expect(press('Inbox', 'ArrowRight')).toBeUndefined();
});

test('the left arrow folds an open line, then steps out to the line that holds it', () => {
  expect(press('Projects', 'ArrowLeft')).toEqual({ fold: true });
  expect(press('Toy Box', 'ArrowLeft')).toBe('Projects');
  expect(press('Trash', 'ArrowLeft')).toBe('Personal');
  expect(press('Personal Inbox', 'ArrowLeft')).toBe('Personal');
  expect(press('Work', 'ArrowLeft')).toBeUndefined();
  expect(press('Flagged', 'ArrowLeft')).toBeUndefined();
});

test('an open line with nothing shown inside it has nowhere to step in to', () => {
  const lines: TreeLine[] = [{ level: 2, isOpen: true }, { level: 2 }];
  expect(treeMove(lines, 0, 'ArrowRight')).toBeUndefined();
});

test('other keys do nothing in the tree, and neither does a line that isn’t there', () => {
  for (const key of ['Enter', ' ', 'a', 'Tab', 'PageDown']) {
    expect(press('Projects', key)).toBeUndefined();
  }
  expect(treeMove(LINES, LINES.length, 'ArrowUp')).toBeUndefined();
});
