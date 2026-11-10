import { expect, test } from 'bun:test';
import { runInNewContext } from 'node:vm';
import { prepaintScript } from './prepaint.ts';
import { parse, THEME_STORAGE_KEY } from './theme/mode.ts';

/** Runs the inline script as the shell does, against a device's storage and an empty `<html>`. */
function paint(storage: { getItem(key: string): string | null }): string | undefined {
  const dataset: Record<string, string> = {};
  const document = { documentElement: { dataset } };
  // A context with only these two globals, so a script that reached for anything else would throw.
  runInNewContext(prepaintScript, { localStorage: storage, document });
  return dataset['theme'];
}

test('the saved Light or Dark choice is on <html> before first paint', () => {
  const saved = (value: string) => ({
    getItem: (key: string) => (key === THEME_STORAGE_KEY ? value : null),
  });

  expect(paint(saved('dark'))).toBe('dark');
  expect(paint(saved('light'))).toBe('light');
});

test('with no saved choice, or one it does not know, the system decides', () => {
  for (const value of [null, 'system', 'sepia', '']) {
    expect(paint({ getItem: () => value })).toBeUndefined();
    expect(parse(value)).toBe('system');
  }
});

test('storage that throws leaves the system in charge instead of breaking the page', () => {
  const blocked = {
    getItem: (): string | null => {
      throw new Error('SecurityError');
    },
  };

  expect(paint(blocked)).toBeUndefined();
});
