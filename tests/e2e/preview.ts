import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '../..');

export type Preview = { url: string; stop: () => Promise<void> };

/**
 * Serves the built app the way production does, on workerd, through `vite preview` under Node. The
 * build must already exist, so a test drives what CI built rather than building its own. The Worker
 * gets the variables a fresh clone starts with, from `.dev.vars.example`, so it signs in as the
 * development member on localhost. `vars` override them, such as `DEMO_MAILBOX`.
 */
export async function startPreview(vars: Record<string, string> = {}): Promise<Preview> {
  if (!existsSync(join(ROOT, 'dist/server/wrangler.json'))) {
    throw new Error('There is no build to drive. Run `bun run build` first.');
  }
  const restoreVars = writeVars({ ...exampleVars(), ...vars });
  const server = Bun.spawn(
    ['node', 'node_modules/vite/bin/vite.js', 'preview', '--port', '0', '--strictPort'],
    { cwd: ROOT, stdout: 'pipe', stderr: 'inherit' },
  );
  const url = await listeningUrl(server.stdout);
  return {
    url,
    stop: async () => {
      server.kill();
      await server.exited;
      restoreVars();
    },
  };
}

/** The variables `.dev.vars.example` sets, as a fresh clone copies them. */
function exampleVars(): Record<string, string> {
  const lines = readFileSync(join(ROOT, '.dev.vars.example'), 'utf8').split('\n');
  return Object.fromEntries(
    lines
      .filter((line) => /^\w+=/.test(line))
      .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
  );
}

/** Writes the build's `.dev.vars`, which the preview reads, and returns its undo. */
function writeVars(vars: Record<string, string>): () => void {
  const file = join(ROOT, 'dist/server/.dev.vars');
  const original = existsSync(file) ? readFileSync(file, 'utf8') : undefined;
  const lines = Object.entries(vars).map(([name, value]) => `${name}='${value}'`);
  writeFileSync(file, [...lines, ''].join('\n'));
  return () => (original === undefined ? rmSync(file) : writeFileSync(file, original));
}

/**
 * The address Vite prints once it listens. Its output keeps draining afterward, since a server
 * whose output pipe closes dies at its next log line.
 */
async function listeningUrl(stdout: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stdout.getReader();
  const decoder = new TextDecoder();
  let printed = '';
  for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
    printed += decoder.decode(chunk.value);
    const url = /Local:\s+(http:\/\/\S+)/.exec(printed)?.[1];
    if (url) {
      void drain(reader);
      return url;
    }
  }
  throw new Error(`The preview stopped before it listened:\n${printed}`);
}

async function drain(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
  while (!(await reader.read()).done);
}
