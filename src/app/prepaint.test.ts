import { expect, test } from 'bun:test';
import { runInNewContext } from 'node:vm';
import { PANELS } from '../features/workbench/index.ts';
import { prepaintScript } from './prepaint.ts';
import { ACCENT_STORAGE_KEY } from './theme/accent.ts';

type Element = { tagName: string; id: string; textContent: string };

/** What the inline script leaves on `<html>` and in `<head>`, run as the shell runs it, first. */
function paint(localStorage: Pick<Storage, 'getItem'>) {
  const style = new Map<string, string>();
  const head: Element[] = [];
  const document = {
    documentElement: {
      style: { setProperty: (name: string, value: string) => style.set(name, value) },
    },
    head: { append: (element: Element) => head.push(element) },
    createElement: (tagName: string): Element => ({ tagName, id: '', textContent: '' }),
  };
  // A context with only these two globals, so a script that reached for anything else would throw.
  runInNewContext(prepaintScript, { localStorage, document });
  return {
    sidebar: style.get(PANELS.sidebar.variable),
    list: style.get(PANELS.list.variable),
    ...(head.length > 0 && { head }),
  };
}

const saved = (entries: Record<string, string>) => ({
  getItem: (key: string) => entries[key] ?? null,
});

test('what storage can’t give leaves the defaults, and a saved width out of range is brought into it', () => {
  const defaults = { sidebar: `${PANELS.sidebar.width}px`, list: `${PANELS.list.width}px` };
  const blocked = {
    getItem: (): string | null => {
      throw new Error('SecurityError');
    },
  };
  const unreadable = saved({
    [ACCENT_STORAGE_KEY]: 'not json',
    [PANELS.sidebar.key]: '{"width":"wide"}',
    [PANELS.list.key]: 'not json',
  });
  const outOfRange = saved({
    [PANELS.sidebar.key]: JSON.stringify({ width: 9999, isCollapsed: false }),
    [PANELS.list.key]: JSON.stringify({ width: 10, isCollapsed: false }),
  });

  expect(paint(saved({}))).toEqual(defaults);
  expect(paint(unreadable)).toEqual(defaults);
  expect(paint(blocked)).toEqual(defaults);
  expect(paint(outOfRange)).toEqual({
    sidebar: `${PANELS.sidebar.max}px`,
    list: `${PANELS.list.min}px`,
  });
});
