import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '../..');

export type Preview = { url: string; stop: () => Promise<void> };

/**
 * Serves the built app the way production does, on workerd, through `vite preview` under Node. The
 * build must already exist, so a test drives what CI built rather than building its own. It signs
 * in as the development member, on localhost. `vars` override the Worker's local variables, such
 * as `DEMO_MAILBOX`, for as long as it serves.
 */
export async function startPreview(vars: Record<string, string> = {}): Promise<Preview> {
  if (!existsSync(join(ROOT, 'dist/server/wrangler.json'))) {
    throw new Error('There is no build to drive. Run `bun run build` first.');
  }
  const restoreVars = overrideVars({ DEV_MEMBER: 'smoke@trailmix.test', ...vars });
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

/** Writes `vars` over the build's `.dev.vars`, which the preview reads, and returns its undo. */
function overrideVars(vars: Record<string, string>): () => void {
  const file = join(ROOT, 'dist/server/.dev.vars');
  const original = existsSync(file) ? readFileSync(file, 'utf8') : undefined;
  const kept = (original ?? '')
    .split('\n')
    .filter((line) => line && !Object.hasOwn(vars, line.split('=')[0] ?? ''));
  const set = Object.entries(vars).map(([name, value]) => `${name}='${value}'`);
  writeFileSync(file, [...kept, ...set, ''].join('\n'));
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
