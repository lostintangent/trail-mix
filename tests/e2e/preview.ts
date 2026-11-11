import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const ROOT = join(import.meta.dir, '../..');

export type Preview = {
  url: string;
  /** Where it keeps its storage, each Durable Object's database among it, until it stops. */
  state: string;
  stop: () => Promise<void>;
  /** The last lines the app printed, the Worker's own logs and errors among them. */
  log: () => string;
};

/** How many of the app's last lines a preview keeps. */
const KEPT_LINES = 300;

/**
 * Serves the built app the way production does, on workerd, through `vite preview` under Node. The
 * build must already exist, so a test drives what CI built rather than building its own. The Worker
 * gets the variables a fresh clone starts with, from `dev.vars.example`, so it signs in as the
 * development member on localhost. `vars` override them, such as `DEMO_MAILBOX`, and `env` adds to
 * the preview's environment, such as a certificate authority for workerd to trust. Each preview
 * keeps its storage in a fresh place, removed when it stops, so Mailrooms an earlier run left, with
 * accounts that still check the test mail server, never wake into this one.
 *
 * `build` names another build to serve, such as the public demo's, which runs as it is deployed:
 * with its own configuration's variables and `vars`, and none from `dev.vars.example`.
 *
 * One preview runs at a time. Each writes its build's `.dev.vars` and points `vite preview` at its
 * build, one file each, so a second would change what the first restarts with.
 */
export async function startPreview(
  vars: Record<string, string> = {},
  env: Record<string, string> = {},
  build: Build = BUILDS.app,
): Promise<Preview> {
  if (!existsSync(join(ROOT, build.directory, 'server/wrangler.json'))) {
    throw new Error(`There is no build to drive. Run \`${build.command}\` first.`);
  }
  if (isRunning) {
    throw new Error('A preview is already running. Stop it before starting another.');
  }
  isRunning = true;
  const restoreVars = writeVars(build, build === BUILDS.app ? { ...exampleVars(), ...vars } : vars);
  const restoreBuild = pointAt(build);
  const state = mkdtempSync(join(tmpdir(), 'trail-mix-preview-'));
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
        TRAIL_MIX_STATE: state,
        ...env,
      },
    },
  );
  const kept: string[] = [];
  // What the Worker reports goes to the app's error output, which is still printed as it comes.
  void keep(server.stderr, kept, (text) => process.stderr.write(text));
  let isStopped = false;
  const stop = async () => {
    if (isStopped) return;
    isStopped = true;
    try {
      server.kill();
      await server.exited;
      restoreVars();
      restoreBuild();
      rmSync(state, { recursive: true, force: true });
    } finally {
      isRunning = false;
    }
  };
  const url = await listeningUrl(server.stdout, kept).catch(async (error: unknown) => {
    await stop();
    throw error;
  });
  return {
    url,
    state,
    stop,
    log: () => kept.join('\n'),
  };
}

/** Whether a preview this process started is running. */
let isRunning = false;

/** A build the tests drive: where it is, and the command that makes it. */
export type Build = { directory: string; command: string };
export const BUILDS = {
  app: { directory: 'dist', command: 'bun run build' },
  demo: { directory: 'dist-demo', command: 'bun run build:demo' },
} satisfies Record<string, Build>;

/** The built Worker's server function ids, by the name of the function in `rpc.ts`. */
export function serverFunctionIds(build: Build = BUILDS.app): Record<string, string> {
  const server = join(ROOT, build.directory, 'server');
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

/** The variables `dev.vars.example` sets, as a fresh clone copies them. */
function exampleVars(): Record<string, string> {
  const lines = readFileSync(join(ROOT, 'dev.vars.example'), 'utf8').split('\n');
  return Object.fromEntries(
    lines
      .filter((line) => /^\w+=/.test(line))
      .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
  );
}

/**
 * Points the preview at `build`, and returns its undo. Vite's preview serves the Worker that the
 * last build named in `.wrangler/deploy/config.json`, whatever its output folder, so after the
 * demo's build it would serve the demo.
 */
function pointAt(build: Build): () => void {
  const file = join(ROOT, '.wrangler/deploy/config.json');
  const original = existsSync(file) ? readFileSync(file, 'utf8') : undefined;
  mkdirSync(dirname(file), { recursive: true });
  const configPath = `../../${build.directory}/server/wrangler.json`;
  writeFileSync(file, JSON.stringify({ configPath, auxiliaryWorkers: [] }));
  return () => (original === undefined ? rmSync(file) : writeFileSync(file, original));
}

/** Writes the build's `.dev.vars`, which the preview reads, and returns its undo. */
function writeVars(build: Build, vars: Record<string, string>): () => void {
  const file = join(ROOT, build.directory, 'server/.dev.vars');
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
