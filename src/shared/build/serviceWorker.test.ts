import { expect, test } from 'bun:test';
import { buildOf, keptOf } from './serviceWorker.ts';

const file = (path: string, content = path) => ({ path, content });

test('the worker keeps what a page loads, once each, and not maps, records or itself', () => {
  const kept = keptOf([
    file('/assets/main-a1.js'),
    file('/assets/main-a1.js.map'),
    file('/.vite/manifest.json'),
    file('/sw.js'),
    file('/favicon.svg', 'built'),
    file('/favicon.svg', 'public'),
    file('/icons/icon-192.png'),
  ]);
  expect(kept).toEqual([
    file('/assets/main-a1.js'),
    file('/favicon.svg', 'built'),
    file('/icons/icon-192.png'),
  ]);
});

test('the version changes when any file’s bytes or name do, and not otherwise', () => {
  const files = [file('/assets/a.js', 'one'), file('/manifest.webmanifest', '{}')];
  const { version, kept } = buildOf(files);
  expect(kept).toEqual(['/assets/a.js', '/manifest.webmanifest']);
  expect(buildOf([...files]).version).toBe(version);
  expect(buildOf([file('/assets/a.js', 'two'), files[1]!]).version).not.toBe(version);
  expect(buildOf([file('/assets/b.js', 'one'), files[1]!]).version).not.toBe(version);
});
