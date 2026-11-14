import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  astryxKeyboardClearance,
  EFFECT,
  splitKeyboardClearance,
} from './astryxKeyboardClearance.ts';

const LAYER = new URL('../../../node_modules/@astryxdesign/core/dist/Layer/', import.meta.url);
const CLEARANCE = readFileSync(new URL('useLayerKeyboardClearance.js', LAYER), 'utf8');
const scan = (code: string) => new Bun.Transpiler({ loader: 'js' }).scan(code);

test("what stays of useLayerKeyboardClearance.js imports none of the keyboard's code, and keeps its exports", () => {
  const { rest } = splitKeyboardClearance(CLEARANCE);
  const { imports, exports } = scan(rest);
  const paths = imports.map(({ path }) => path);
  expect(paths).not.toContain('../keyboard/keyboardHeight.js');
  expect(paths).not.toContain('../keyboard/keyboardLayoutGuide.js');
  expect(paths).not.toContain('../utils/browserClickWait.js');
  expect(paths).toContain(`./useLayerKeyboardClearance.js${EFFECT}`);
  // Selector reads the inset's property from it, and the layer runtime the hook.
  expect(exports.toSorted()).toEqual(scan(CLEARANCE).exports.toSorted());
});

test('the cut effect loads once the first screen settles, or when a layer opens first, and runs with its own state', async () => {
  const effects: { callback: () => unknown; deps: unknown[] }[] = [];
  const set: unknown[][] = [];
  const useState = (initial: unknown) => [initial, (value: unknown) => set.push([initial, value])];
  let arrive = () => {};
  const loads: Promise<unknown>[] = [];
  const later: (() => void)[] = [];
  const clearKeyboard = (names: Record<string, unknown>) => names;
  const { useLayerKeyboardClearance } = await evaluate<{
    useLayerKeyboardClearance: (isOpen: boolean, layerRef: object) => unknown;
  }>(splitKeyboardClearance(CLEARANCE).rest, {
    useState,
    useState$: useState,
    useRef: (current: unknown) => ({ current }),
    useCallback: (callback: unknown) => callback,
    useIsomorphicLayoutEffect: (callback: () => unknown, deps: unknown[]) =>
      effects.push({ callback, deps }),
    afterFirstScreen$: (load: () => void) => {
      later.push(load);
      return () => {};
    },
    load: () => {
      const loaded = new Promise((resolve) => {
        arrive = () => resolve({ clearKeyboard });
      });
      loads.push(loaded);
      return loaded;
    },
  });
  const layerRef = { current: null };

  // Closed layers load nothing on the first screen, and leave it one load for after.
  useLayerKeyboardClearance(false, layerRef);
  expect(effects.at(-1)!.callback()).toBeUndefined();
  useLayerKeyboardClearance(false, layerRef);
  effects.at(-1)!.callback();
  expect(loads).toHaveLength(0);
  expect(later).toHaveLength(1);

  // A layer that opens first loads it at once, and the load after the first screen joins it.
  useLayerKeyboardClearance(true, layerRef);
  effects.at(-1)!.callback();
  expect(loads).toHaveLength(1);
  later[0]!();
  expect(loads).toHaveLength(1);
  arrive();
  await new Promise((resolve) => setTimeout(resolve, 0));
  // The layer renders again, with the effect's code in hand.
  expect(set).toContainEqual([false, true]);

  useLayerKeyboardClearance(true, layerRef);
  const names = effects.at(-1)!.callback() as Record<string, unknown>;
  expect(Object.keys(names).toSorted()).toEqual([
    'capRef',
    'isOpen',
    'keyboardInsetRef',
    'layerRef',
    'resyncRef',
    'setCap',
    'setKeyboardInset',
  ]);
  expect(names.isOpen).toBe(true);
  expect(names.layerRef).toBe(layerRef);
  expect(loads).toHaveLength(1);
});

test('the cut effect keeps what it reads, and caps a layer opened over the keyboard as it did', async () => {
  const real = (await import(new URL('layerKeyboardClearance.js', LAYER).href)) as Record<
    string,
    unknown
  >;
  const microtasks: (() => void)[] = [];
  const win = {
    queueMicrotask: (task: () => void) => microtasks.push(task),
    setTimeout,
    clearTimeout,
    requestAnimationFrame: () => 0,
    cancelAnimationFrame: () => {},
    performance: { now: () => 0 },
  };
  const layer = {
    ownerDocument: { defaultView: win, activeElement: null },
    hasAttribute: (name: string) => name === real.LAYER_ANCHORED_ATTRIBUTE,
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  let cap: number | null = null;
  const caps: (number | null)[] = [];
  const insets: (number | null)[] = [];
  const { clearKeyboard } = await evaluate<{
    clearKeyboard: (names: Record<string, unknown>) => () => void;
  }>(splitKeyboardClearance(CLEARANCE).effect, {
    ...real,
    flushSync: (update: () => void) => update(),
    getKeyboardLayoutGuide: () => ({ profile: 'webkit', subscribe: () => () => {} }),
    getKeyboardHeight: () => 300,
    layoutViewportHeight: () => 800,
    settledBox: () => ({ top: 100, bottom: 100 + (cap ?? 600) }),
    timing: { keyboardNotificationMs: 0 },
    awaitBrowserClick: () => () => {},
    subscribeInput: () => () => {},
  });

  const close = clearKeyboard({
    isOpen: true,
    layerRef: { current: layer },
    capRef: { current: null },
    keyboardInsetRef: { current: null },
    resyncRef: { current: null },
    setCap: (next: number | null) => caps.push((cap = next)),
    setKeyboardInset: (next: number | null) => insets.push(next),
  });
  for (const task of microtasks.splice(0)) task();
  // 800 tall, a keyboard of 300 and 10 to spare: the layer from 100 ends at 490.
  expect(caps.at(-1)).toBe(390);
  expect(insets.at(-1)).toBe(310);

  close();
  expect(caps.at(-1)).toBeNull();
  expect(insets.at(-1)).toBeNull();
});

test("a useLayerKeyboardClearance.js the cut no longer fits stops the build, rather than keeping the keyboard's code", () => {
  const renamed = CLEARANCE.replace(
    'export function useLayerKeyboardClearance(isOpen,',
    'export function useLayerKeyboardAvoidance(isOpen,',
  );
  expect(renamed).not.toBe(CLEARANCE);
  expect(() => splitKeyboardClearance(renamed)).toThrow(/no longer exports one/);

  const options = CLEARANCE.replace(
    'export function useLayerKeyboardClearance(isOpen,',
    'export function useLayerKeyboardClearance(options,',
  );
  expect(() => splitKeyboardClearance(options)).toThrow(/no longer takes isOpen first/);

  const passive = CLEARANCE.replace('useIsomorphicLayoutEffect(() => {', 'useEffect(() => {');
  expect(() => splitKeyboardClearance(passive)).toThrow(/no longer has one/);
});

test("the build fails when the chunk holding useLayerKeyboardClearance.js loads the keyboard's code, and not when only a lazy one does", () => {
  const chunk = (
    fileName: string,
    modules: string[],
    imports: string[] = [],
    dynamic: string[] = [],
  ) => ({
    type: 'chunk',
    fileName,
    imports,
    dynamicImports: dynamic,
    modules: Object.fromEntries(modules.map((id) => [id, { renderedLength: 1 }])),
  });
  const astryx = (path: string) => `/app/node_modules/@astryxdesign/core/dist/${path}`;
  const failures = (bundle: Record<string, unknown>) => {
    const errors: string[] = [];
    const generateBundle = astryxKeyboardClearance().generateBundle as (
      this: { error: (message: string) => void },
      options: unknown,
      bundle: Record<string, unknown>,
    ) => void;
    generateBundle.call({ error: (message: string) => errors.push(message) }, {}, bundle);
    return errors;
  };

  const lazy = {
    'first.js': chunk('first.js', [astryx('Layer/useLayerKeyboardClearance.js')], [], ['k.js']),
    'k.js': chunk('k.js', [astryx('keyboard/keyboardHeight.js')], ['first.js']),
  };
  expect(failures(lazy)).toEqual([]);

  const loaded = {
    'first.js': chunk('first.js', [astryx('Layer/useLayerKeyboardClearance.js')], ['k.js']),
    'k.js': chunk('k.js', [astryx('keyboard/keyboardHeight.js')]),
  };
  expect(failures(loaded)).toEqual([
    "Astryx's keyboard code is in k.js, which loads with useLayerKeyboardClearance.js, so it is back on the first load.",
  ]);
});

/**
 * Runs `code` as a module whose imports are stand-ins, so a name it reads but no longer has throws
 * as it runs. Its lazy import of the cut effect calls `standIns.load`.
 */
async function evaluate<T>(code: string, standIns: Record<string, unknown>): Promise<T> {
  const bound = Array.from(code.matchAll(/^import \{([^}]*)\}/gm), ([, names = '']) =>
    names.split(',').map((name) =>
      name
        .trim()
        .split(/\s+as\s+/)
        .at(-1)!,
    ),
  )
    .flat()
    .filter(Boolean);
  const folder = mkdtempSync(join(tmpdir(), 'keyboard-clearance-'));
  const module = join(folder, 'module.mjs');
  (globalThis as unknown as { standIns: typeof standIns }).standIns = standIns;
  writeFileSync(
    module,
    `const { ${bound.join(', ')} } = globalThis.standIns;\n` +
      code
        .replace(/^import [^;]+;\n/gm, '')
        .replace(/^export \{[^}]*\} from [^;]+;\n/gm, '')
        .replace(`import("./useLayerKeyboardClearance.js${EFFECT}")`, 'globalThis.standIns.load()'),
  );
  try {
    return (await import(module)) as T;
  } finally {
    rmSync(folder, { recursive: true });
  }
}
