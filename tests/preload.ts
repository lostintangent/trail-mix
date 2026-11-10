import stylex from '@stylexjs/unplugin/vite';
import { plugin } from 'bun';
import { stylexOptions } from '../src/shared/build/stylexOptions.ts';

// Vite loads before any test file runs, so before any test compiles StyleX with Babel. Babel then
// installs its own `Error.prepareStackTrace`, after which Bun's `Error.captureStackTrace` rejects
// objects that are not errors (oven-sh/bun#46393). Vite builds some error classes that way as it
// loads, so loading it later fails.
await import('vite');

// Tests import the app's modules as the build compiles them. StyleX's calls only work compiled,
// so a module that styles itself would otherwise throw as soon as a test imported it.
const compiler = stylex(stylexOptions) as unknown as {
  transform(this: unknown, code: string, id: string): Promise<{ code: string } | null>;
};
plugin({
  name: 'stylex',
  setup(build) {
    build.onLoad({ filter: /\/src\/.*\.tsx?$/ }, async ({ path }) => {
      const source = await Bun.file(path).text();
      const loader = path.endsWith('.tsx') ? 'tsx' : 'ts';
      if (!source.includes('@stylexjs/stylex')) return { contents: source, loader };
      const compiled = await compiler.transform.call({}, source, path);
      return { contents: compiled?.code ?? source, loader };
    });
  },
});
