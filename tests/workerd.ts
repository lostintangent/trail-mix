import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
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
  const port = await freePort();
  // Node starts workerd, because Miniflare cannot reach it under Bun (oven-sh/bun#39247).
  const workerd = spawn(
    'node',
    [
      join(import.meta.dir, '../node_modules/wrangler/bin/wrangler.js'),
      'dev',
      '--config',
      join(scratch, 'wrangler.json'),
      '--port',
      String(port),
      '--ip',
      '127.0.0.1',
      '--persist-to',
      join(scratch, 'state'),
      '--log-level',
      logs ? 'log' : 'error',
    ],
    {
      cwd: scratch,
      detached: true,
      stdio: logs ? 'inherit' : 'ignore',
      env: {
        ...process.env,
        // Wrangler otherwise keeps a debug log of every run in its own folder.
        WRANGLER_WRITE_LOGS: 'false',
        WRANGLER_SEND_METRICS: 'false',
        ...env,
      },
    },
  );
  const stop = () => {
    if (workerd.pid) {
      try {
        process.kill(-workerd.pid, 'SIGKILL');
      } catch {
        // Already gone.
      }
    }
    rmSync(scratch, { recursive: true, force: true });
  };
  const url = `http://127.0.0.1:${port}`;
  try {
    await until(`${url}/`);
  } catch (error) {
    stop();
    throw error;
  }
  return { url, stop, group: workerd.pid! };
}

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = createServer().listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => resolve(typeof address === 'object' && address ? address.port : 0));
    });
  });
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
