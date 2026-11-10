import { existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '../..');

export type Preview = { url: string; stop: () => Promise<void> };

/**
 * Serves the built app the way production does, on workerd, through `vite preview` under Node. The
 * build must already exist, so a test drives what CI built rather than building its own.
 */
export async function startPreview(): Promise<Preview> {
  if (!existsSync(join(ROOT, 'dist/server/wrangler.json'))) {
    throw new Error('There is no build to drive. Run `bun run build` first.');
  }
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
    },
  };
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
