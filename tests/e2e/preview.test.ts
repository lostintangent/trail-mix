import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { BUILDS, changedSince } from './preview.ts';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true });
});

/** A checkout with `files` written `at` seconds since the epoch, and the demo built at 100. */
function checkout(files: Record<string, number>): string {
  const root = mkdtempSync(join(tmpdir(), 'trail-mix-checkout-'));
  roots.push(root);
  for (const [path, at] of Object.entries({ ...files, 'dist-demo/server/wrangler.json': 100 })) {
    const file = join(root, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, '');
    utimesSync(file, at, at);
  }
  return root;
}

const BUILT = {
  'src/app/main.tsx': 90,
  'src/features/mail/core/model.ts': 50,
  'public/icons/192.png': 10,
  'vite.config.ts': 20,
  'package.json': 20,
  'bun.lock': 20,
  'wrangler.jsonc': 20,
};

test('a build newer than everything it is made from is current', () => {
  expect(changedSince(BUILDS.demo, checkout(BUILT))).toBeUndefined();
  // Inputs a checkout doesn't have are none newer.
  expect(changedSince(BUILDS.demo, checkout({ 'src/app/main.tsx': 90 }))).toBeUndefined();
});

test('a build is older than the newest source, served file or build setting changed since', () => {
  for (const input of Object.keys(BUILT)) {
    expect(changedSince(BUILDS.demo, checkout({ ...BUILT, [input]: 101 }))).toBe(input);
  }
  expect(
    changedSince(
      BUILDS.demo,
      checkout({ ...BUILT, 'src/app/main.tsx': 150, 'src/features/mail/core/model.ts': 200 }),
    ),
  ).toBe('src/features/mail/core/model.ts');
  // An input the checkout doesn't have skips only itself.
  const { 'public/icons/192.png': _, ...unserved } = BUILT;
  expect(changedSince(BUILDS.demo, checkout({ ...unserved, 'wrangler.jsonc': 101 }))).toBe(
    'wrangler.jsonc',
  );
});

test('a test or a hidden file changed under src leaves the build current', () => {
  expect(
    changedSince(
      BUILDS.demo,
      checkout({
        ...BUILT,
        'src/features/mail/core/model.test.ts': 200,
        'src/app/theme/SenderAvatar.test.tsx': 200,
        'src/features/.DS_Store': 200,
      }),
    ),
  ).toBeUndefined();
});
