// Workers started side by side each answer at their own address: Wrangler picks each port as it
// binds it, so no Worker is handed a port another process took first. Each Worker and its files
// live in a temporary folder, so writing one restarts nothing else on the machine.
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

test('a Worker answers in full while a file it bundles is written', async () => {
  // Half its answer now and half two seconds later, streamed as the mail check streams its checks.
  const slow = join(folder, 'slow.js');
  const source = `export default {
    fetch() {
      const { readable, writable } = new TransformStream();
      const writer = writable.getWriter();
      const text = (part) => writer.write(new TextEncoder().encode(part));
      void text('first ');
      setTimeout(() => text('second').then(() => writer.close()), 2000);
      return new Response(readable, { headers: { 'content-type': 'application/x-ndjson' } });
    },
  };\n`;
  writeFileSync(slow, source);
  const worker = await startWorker({ name: 'slow', main: slow });
  try {
    const parts: string[] = [];
    for await (const part of (await fetch(worker.url)).body!.pipeThrough(new TextDecoderStream())) {
      // An edit, or a `git pull --autostash`, while the answer is on its way.
      if (parts.push(part) === 1) writeFileSync(slow, `${source}// edited\n`);
    }
    expect(parts.join('')).toBe('first second');
  } finally {
    worker.stop();
  }
}, 120_000);
