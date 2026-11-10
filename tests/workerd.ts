import { spawn } from 'node:child_process';
import { mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import shellConfig from '../wrangler.jsonc';

const shell = shellConfig as { compatibility_date: string; compatibility_flags: string[] };

export type LocalWorker = {
  url: string;
  stop: () => void;
  /** The process group of everything it started, workerd among them. */
  group: number;
};

/**
 * Runs a Worker on the local Workers runtime, for the check command and the tests that need
 * workerd, with its own storage in a scratch folder that `stop` deletes. It runs with the shell's
 * compatibility date and flags, so it tests the same runtime the app runs on.
 *
 * `config` is the rest of a Wrangler configuration, such as `main` and bindings. `env` adds to the
 * environment Wrangler starts in, such as `NODE_EXTRA_CA_CERTS`. With `logs`, what the Worker
 * prints shows in the test's output.
 */
export async function startWorker(
  config: Record<string, unknown>,
  { env = {}, logs = false }: { env?: Record<string, string>; logs?: boolean } = {},
): Promise<LocalWorker> {
  const scratch = mkdtempSync(join(tmpdir(), 'trail-mix-workerd-'));
  writeFileSync(
    join(scratch, 'wrangler.json'),
    JSON.stringify({
      compatibility_date: shell.compatibility_date,
      compatibility_flags: shell.compatibility_flags,
      ...config,
    }),
  );
  // Wrangler prints where it listens, and everything after, into a file: a file never fills, as a
  // pipe nobody reads would, and it outlives the test that started the Worker.
  const output = join(scratch, 'wrangler.log');
  const written = openSync(output, 'a');
  // Node starts workerd, because Miniflare cannot reach it under Bun (oven-sh/bun#39247). A shell
  // that exits at once starts Node, so the Worker runs on its own: when a test times out, Bun ends
  // the processes its tests and hooks started, and a Worker started from a hook would go with it.
  // Everything stays in the shell's process group, which `stop` ends.
  const workerd = spawn(
    '/bin/sh',
    [
      '-c',
      '"$@" &',
      'sh',
      'node',
      join(import.meta.dir, '../node_modules/wrangler/bin/wrangler.js'),
      'dev',
      '--config',
      join(scratch, 'wrangler.json'),
      // Wrangler takes free ports, for the Worker and for its inspector, as it binds them. A port
      // found free beforehand could be taken in between, by another Worker starting or by one of the
      // ports Wrangler and workerd bind for themselves.
      '--port',
      '0',
      '--inspector-port',
      '0',
      '--ip',
      '127.0.0.1',
      '--persist-to',
      join(scratch, 'state'),
      // Where it listens is said at `info`.
      '--log-level',
      logs ? 'log' : 'info',
    ],
    {
      cwd: scratch,
      detached: true,
      stdio: ['ignore', written, written],
      env: {
        ...process.env,
        // Wrangler otherwise keeps a debug log of every run in its own folder.
        WRANGLER_WRITE_LOGS: 'false',
        WRANGLER_SEND_METRICS: 'false',
        // Wrangler's local explorer, and the collector behind it that records a span for every SQL
        // statement and socket read in a database of its own, on the Worker's thread. A deployed
        // Worker has neither, and with them on they cost as much CPU as the Mailroom itself. Keep them
        // off: a bench measures what production runs, and turning them on would charge Wrangler's
        // work to the Mailroom's budgets.
        X_LOCAL_EXPLORER: 'false',
        X_LOCAL_OBSERVABILITY: 'false',
        ...env,
      },
    },
  );
  const following = logs ? follow(output) : undefined;
  const stop = () => {
    following?.stop();
    if (workerd.pid) {
      try {
        process.kill(-workerd.pid, 'SIGKILL');
      } catch {
        // Already gone.
      }
    }
    rmSync(scratch, { recursive: true, force: true });
  };
  try {
    const url = await listening(output, workerd.pid!);
    await until(`${url}/`);
    return { url, stop, group: workerd.pid! };
  } catch (error) {
    stop();
    throw error;
  }
}

/** The address Wrangler says it is ready on, once it says so. */
async function listening(output: string, group: number): Promise<string> {
  const deadline = Date.now() + 60_000;
  for (;;) {
    const printed = Bun.stripANSI(readFileSync(output, 'utf8'));
    const url = /Ready on (http:\/\/127\.0\.0\.1:\d+)/.exec(printed)?.[1];
    if (url) return url;
    if (Date.now() > deadline || !running(group)) {
      throw new Error(`workerd did not start:\n${printed.slice(-2000)}`);
    }
    await Bun.sleep(100);
  }
}

/** Whether any process of the group is still running. */
function running(group: number): boolean {
  try {
    process.kill(-group, 0);
    return true;
  } catch {
    return false;
  }
}

/** Prints what Wrangler writes to `output` as it comes, until stopped. */
function follow(output: string) {
  let shown = 0;
  const show = () => {
    const printed = readFileSync(output);
    process.stdout.write(printed.subarray(shown));
    shown = printed.length;
  };
  const timer = setInterval(show, 200);
  return {
    stop() {
      clearInterval(timer);
      show();
    },
  };
}

async function until(url: string) {
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      await fetch(url);
      return;
    } catch (error) {
      if (Date.now() > deadline) throw new Error('workerd did not start', { cause: error });
      await Bun.sleep(250);
    }
  }
}
