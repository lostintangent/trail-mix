import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '../..');

export type Preview = {
  url: string;
  stop: () => Promise<void>;
  /** The last lines the app printed, the Worker's own logs and errors among them. */
  log: () => string;
};

/** How many of the app's last lines a preview keeps. */
const KEPT_LINES = 300;

/**
 * Serves the built app the way production does, on workerd, through `vite preview` under Node. The
 * build must already exist, so a test drives what CI built rather than building its own. The Worker
 * gets the variables a fresh clone starts with, from `.dev.vars.example`, so it signs in as the
 * development member on localhost. `vars` override them, such as `DEMO_MAILBOX`, and `env` adds to
 * the preview's environment, such as a certificate authority for workerd to trust.
 */
export async function startPreview(
  vars: Record<string, string> = {},
  env: Record<string, string> = {},
): Promise<Preview> {
  if (!existsSync(join(ROOT, 'dist/server/wrangler.json'))) {
    throw new Error('There is no build to drive. Run `bun run build` first.');
  }
  const restoreVars = writeVars({ ...exampleVars(), ...vars });
  const server = Bun.spawn(
    ['node', 'node_modules/vite/bin/vite.js', 'preview', '--port', '0', '--strictPort'],
    {
      cwd: ROOT,
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        ...process.env,
        // Vite colors its output whenever `CI` is set, which would break the address up with escapes.
        NO_COLOR: '1',
        // Wrangler's local trace collector records every statement and socket read in the Worker's
        // own thread. A deployed Worker has none of it, so it stays out of what the bench measures.
        X_LOCAL_EXPLORER: 'false',
        X_LOCAL_OBSERVABILITY: 'false',
        ...env,
      },
    },
  );
  const kept: string[] = [];
  // What the Worker reports goes to the app's error output, which is still printed as it comes.
  void keep(server.stderr, kept, (text) => process.stderr.write(text));
  const url = await listeningUrl(server.stdout, kept);
  return {
    url,
    stop: async () => {
      server.kill();
      await server.exited;
      restoreVars();
    },
    log: () => kept.join('\n'),
  };
}

/** The built Worker's server function ids, by the name of the function in `rpc.ts`. */
export function serverFunctionIds(): Record<string, string> {
  const server = join(ROOT, 'dist/server');
  const ids: Record<string, string> = {};
  for (const file of readdirSync(server, { recursive: true, encoding: 'utf8' })) {
    if (!file.endsWith('.js')) continue;
    for (const [, id = '', name = ''] of readFileSync(join(server, file), 'utf8').matchAll(
      MANIFEST_ENTRY,
    )) {
      ids[name] = id;
    }
  }
  if (Object.keys(ids).length === 0) throw new Error('The build has no server function manifest.');
  return ids;
}

/** An entry of Start's manifest: `"<id>": { functionName: "<name>_createServerFn_handler"`. */
const MANIFEST_ENTRY = /"(\w+)":\s*\{\s*functionName:\s*"(\w+)_createServerFn_handler"/g;

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
 * The address Vite prints once it listens. Its output keeps draining afterward, into `kept`, since
 * a server whose output pipe closes dies at its next log line.
 */
async function listeningUrl(stdout: ReadableStream<Uint8Array>, kept: string[]): Promise<string> {
  // What it printed before it listened, which is all a failure to start has to say.
  let printed: string | undefined = '';
  const { promise: listening, resolve } = Promise.withResolvers<string | undefined>();
  void keep(stdout, kept, (text) => {
    if (printed === undefined) return;
    printed += text;
    const url = /Local:\s+(http:\/\/\S+)/.exec(printed)?.[1];
    if (!url) return;
    printed = undefined;
    resolve(url);
  }).finally(() => resolve(undefined));
  const url = await listening;
  if (url === undefined) throw new Error(`The preview stopped before it listened:\n${printed}`);
  return url;
}

/** Reads `output` to its end, keeping its last lines in `kept`, and hands each piece to `heard`. */
async function keep(
  output: ReadableStream<Uint8Array>,
  kept: string[],
  heard: (text: string) => void,
): Promise<void> {
  const decoder = new TextDecoder();
  let partial = '';
  for await (const chunk of output) {
    const text = decoder.decode(chunk, { stream: true });
    heard(text);
    const lines = (partial + text).split('\n');
    partial = lines.pop() ?? '';
    kept.push(...lines);
    kept.splice(0, Math.max(0, kept.length - KEPT_LINES));
  }
}
