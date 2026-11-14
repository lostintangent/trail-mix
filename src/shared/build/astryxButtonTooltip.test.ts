import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { astryxButtonTooltip, laterButtonTooltip } from './astryxButtonTooltip.ts';

const BUTTON = readFileSync(
  new URL('../../../node_modules/@astryxdesign/core/dist/Button/Button.js', import.meta.url),
  'utf8',
);
const LATER = '/app/src/shared/LaterTooltip.tsx';
const scan = (code: string) => new Bun.Transpiler({ loader: 'js' }).scan(code);

test("Button.js takes its tooltip hook from the app, and imports none of Astryx's tooltip code", () => {
  const later = laterButtonTooltip(BUTTON, LATER);
  const paths = scan(later).imports.map(({ path }) => path);
  expect(paths).toContain(LATER);
  expect(paths).not.toContain('../Tooltip/useTooltip.js');
  expect(later).toContain(`import { useLaterTooltip as useTooltip } from "${LATER}";`);
  expect(scan(later).exports).toEqual(scan(BUTTON).exports);
});

test('a Button.js that reads more of the hook than the later one gives, or imports it otherwise, stops the build', () => {
  const variants = [
    ['tooltipHook.describedBy', 'tooltipHook.anchorId', /reads tooltipHook\.anchorId/],
    ['tooltipHook.describedBy', 'tooltipHook["describedBy"]', /reads tooltipHook\["describedBy"\]/],
    [
      'const mergedButtonRef = useMergedRefs(',
      'void [tooltipHook];\n  const mergedButtonRef = useMergedRefs(',
      /reads \[tooltipHook\]/,
    ],
    [
      'from "../Tooltip/useTooltip.js"',
      'from "../Tooltip/index.js"',
      /no longer imports useTooltip/,
    ],
  ] as const;
  for (const [was, now, says] of variants) {
    const changed = BUTTON.replace(was, now);
    expect(changed).not.toBe(BUTTON);
    expect(() => laterButtonTooltip(changed, LATER)).toThrow(says);
  }
});

test("the build fails when the chunk holding Button.js loads the tooltip's code, and not when only a lazy one does", () => {
  const chunk = (fileName: string, modules: string[], imports: string[] = []) => ({
    type: 'chunk',
    fileName,
    imports,
    modules: Object.fromEntries(modules.map((id) => [id, { renderedLength: 1 }])),
  });
  const astryx = (path: string) => `/app/node_modules/@astryxdesign/core/dist/${path}`;
  const failures = (bundle: Record<string, unknown>) => {
    const errors: string[] = [];
    const generateBundle = astryxButtonTooltip().generateBundle as (
      this: { error: (message: string) => void },
      options: unknown,
      bundle: Record<string, unknown>,
    ) => void;
    generateBundle.call({ error: (message: string) => errors.push(message) }, {}, bundle);
    return errors;
  };
  const tooltip = chunk('tip.js', [astryx('Tooltip/useTooltip.js'), astryx('Layer/useLayer.js')]);

  expect(
    failures({ 'button.js': chunk('button.js', [astryx('Button/Button.js')]), 'tip.js': tooltip }),
  ).toEqual([]);
  const loaded = {
    'button.js': chunk('button.js', [astryx('Button/Button.js')], ['shared.js']),
    'shared.js': chunk('shared.js', [], ['tip.js']),
    'tip.js': tooltip,
  };
  expect(failures(loaded).map((error) => error.split(',')[0])).toEqual([
    "Astryx's Tooltip/useTooltip.js is in tip.js",
    "Astryx's Layer/useLayer.js is in tip.js",
  ]);
});
