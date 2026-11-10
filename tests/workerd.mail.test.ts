// Workers started side by side each answer at their own address: Wrangler picks each port as it
// binds it, so no Worker is handed a port another process took first.
import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startWorker, type LocalWorker } from './workerd.ts';

const folder = mkdtempSync(join(tmpdir(), 'trail-mix-named-worker-'));
const main = join(folder, 'named.js');
writeFileSync(main, 'export default { fetch: (request, env) => new Response(env.NAME) };\n');
afterAll(() => rmSync(folder, { recursive: true, force: true }));

const named = (name: string) => startWorker({ name: 'named', main, vars: { NAME: name } });
const answer = async ({ url }: LocalWorker) => (await fetch(url)).text();

test('Workers started at once each answer at their own address', async () => {
  const names = ['a', 'b', 'c', 'd', 'e', 'f'];
  const workers = await Promise.all(names.map(named));
  try {
    expect(await Promise.all(workers.map(answer))).toEqual(names);
    expect(new Set(workers.map(({ url }) => url)).size).toBe(names.length);
  } finally {
    for (const worker of workers) worker.stop();
  }
}, 120_000);
