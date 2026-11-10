import { expect, test } from 'bun:test';
import { join } from 'node:path';

// The app loads only the theme's built output, so an edit to `trail-mix.ts` must be rebuilt with
// `bun run theme` before it shows. `astryx theme build --check` compares without writing.
test('the built theme matches its source', async () => {
  const check = Bun.spawn(['bun', 'run', 'theme', '--check'], {
    cwd: join(import.meta.dir, '../../..'),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    check.exited,
    new Response(check.stdout).text(),
    new Response(check.stderr).text(),
  ]);

  expect({ exitCode, output: `${stdout}${stderr}`.trim() }).toMatchObject({ exitCode: 0 });
}, 30_000);
