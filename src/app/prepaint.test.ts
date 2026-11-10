import { expect, test } from 'bun:test';
import { runInNewContext } from 'node:vm';
import { PANELS } from '../features/workbench/index.ts';
import { prepaintScript } from './prepaint.ts';
import { ACCENT_STORAGE_KEY, ACCENT_STYLE_ID } from './theme/accent.ts';
import { THEME_STORAGE_KEY } from './theme/mode.ts';
import { accentRule } from './theme/readableAccent.ts';

type Element = { tagName: string; id: string; textContent: string };

/** What the inline script leaves on `<html>` and in `<head>`, run as the shell runs it, first. */
function paint(localStorage: Pick<Storage, 'getItem'>) {
  const dataset: Record<string, string> = {};
  const style = new Map<string, string>();
  const head: Element[] = [];
  const document = {
    documentElement: {
      dataset,
      style: { setProperty: (name: string, value: string) => style.set(name, value) },
    },
    head: { append: (element: Element) => head.push(element) },
    createElement: (tagName: string): Element => ({ tagName, id: '', textContent: '' }),
  };
  // A context with only these two globals, so a script that reached for anything else would throw.
  runInNewContext(prepaintScript, { localStorage, document });
  return {
    theme: dataset['theme'],
    sidebar: style.get(PANELS.sidebar.variable),
    list: style.get(PANELS.list.variable),
    ...(head.length > 0 && { head }),
  };
}

const saved = (entries: Record<string, string>) => ({
  getItem: (key: string) => entries[key] ?? null,
});

test('the saved theme, accent and panel sizes are on the page before first paint', () => {
  const css = accentRule('#c2185b')!;
  const painted = paint(
    saved({
      [THEME_STORAGE_KEY]: 'dark',
      [ACCENT_STORAGE_KEY]: JSON.stringify({ color: '#c2185b', css }),
      [PANELS.sidebar.key]: JSON.stringify({ width: 300, isCollapsed: false }),
      [PANELS.list.key]: JSON.stringify({ width: 420, isCollapsed: true }),
    }),
  );

  expect(painted).toEqual({
    theme: 'dark',
    sidebar: '300px',
    list: `${PANELS.list.rail}px`,
    head: [{ tagName: 'style', id: ACCENT_STYLE_ID, textContent: css }],
  });
});

test('with nothing saved, the system picks the theme and the panels take their widths', () => {
  expect(paint(saved({}))).toEqual({
    theme: undefined,
    sidebar: `${PANELS.sidebar.width}px`,
    list: `${PANELS.list.width}px`,
  });
});

test('a saved value it does not understand is ignored rather than breaking the page', () => {
  const painted = paint(
    saved({
      [THEME_STORAGE_KEY]: 'sepia',
      [ACCENT_STORAGE_KEY]: 'not json',
      [PANELS.sidebar.key]: '{"width":"wide"}',
      [PANELS.list.key]: 'not json',
    }),
  );

  expect(painted).toEqual({
    theme: undefined,
    sidebar: `${PANELS.sidebar.width}px`,
    list: `${PANELS.list.width}px`,
  });
});

test('storage that throws leaves the defaults in charge', () => {
  const blocked = {
    getItem: (): string | null => {
      throw new Error('SecurityError');
    },
  };

  expect(paint(blocked)).toEqual({
    theme: undefined,
    sidebar: `${PANELS.sidebar.width}px`,
    list: `${PANELS.list.width}px`,
  });
});
