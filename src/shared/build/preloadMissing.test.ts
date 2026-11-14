import { expect, test } from 'bun:test';
import { lacking } from './preloadMissing.ts';

const chunk = (fileName: string, imports: string[] = []) => ({
  type: 'chunk' as const,
  fileName,
  imports,
});

test('a lazy import preloads only what its importer has not loaded by its static imports', () => {
  const lacks = lacking({
    'assets/index.js': chunk('assets/index.js', ['assets/react.js']),
    'assets/react.js': chunk('assets/react.js'),
    'assets/workbench.js': chunk('assets/workbench.js', ['assets/index.js', 'assets/button.js']),
    'assets/button.js': chunk('assets/button.js', ['assets/react.js']),
    'assets/Reader.js': chunk('assets/Reader.js', ['assets/button.js', 'assets/sanitize.js']),
    'assets/sanitize.js': chunk('assets/sanitize.js'),
    'assets/index.css': { type: 'asset' as const, fileName: 'assets/index.css' },
  });
  const readerDeps = [
    'assets/Reader.js',
    'assets/button.js',
    'assets/react.js',
    'assets/sanitize.js',
  ];
  // The workbench has loaded the button and, through the index, React.
  expect(lacks(readerDeps, 'assets/workbench.js')).toEqual([
    'assets/Reader.js',
    'assets/sanitize.js',
  ]);
  // The index hasn't loaded the button, which only the workbench imports.
  expect(lacks(readerDeps, 'assets/index.js')).toEqual([
    'assets/Reader.js',
    'assets/button.js',
    'assets/sanitize.js',
  ]);
  // A page isn't a chunk, so it lacks everything.
  expect(lacks(readerDeps, 'index.html')).toEqual(readerDeps);
});
