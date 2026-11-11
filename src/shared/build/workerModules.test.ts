import { expect, test } from 'bun:test';
import { unreachable } from './workerModules.ts';

const chunk = (
  fileName: string,
  imports: string[] = [],
  dynamic: string[] = [],
  isEntry = false,
) => ({
  type: 'chunk' as const,
  fileName,
  isEntry,
  imports,
  dynamicImports: dynamic,
});
const map = (fileName: string) => ({ type: 'asset' as const, fileName });

test('the Worker keeps every module its entry reaches, by static or dynamic import, and nothing else', () => {
  const bundle = {
    'index.js': chunk('index.js', ['shared.js', 'cloudflare:workers'], ['router.js'], true),
    'index.js.map': map('index.js.map'),
    'shared.js': chunk('shared.js'),
    'router.js': chunk('router.js', ['shared.js'], ['keep.js']),
    'keep.js': chunk('keep.js'),
    // A component the server build dropped, whose chunk Rolldown wrote anyway, and what only it loads.
    'Composer.js': chunk('Composer.js', ['shared.js', 'editor.js']),
    'Composer.js.map': map('Composer.js.map'),
    'editor.js': chunk('editor.js'),
  };
  expect(unreachable(bundle).sort()).toEqual(['Composer.js', 'Composer.js.map', 'editor.js']);
});
