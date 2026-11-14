import { spawn, spawnSync } from 'node:child_process';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Deploys a built Worker. The Deploy to Cloudflare button's builds run it as `bun run deploy`, so
 * do production's and the demo's workflows, and so can anyone with a clone signed in with
 * `wrangler login`. It runs under Node, as Wrangler does. `--config` names the build, which is
 * `dist/server/wrangler.json` unless given, and every other argument goes on to `wrangler deploy`.
 *
 * Before deploying, it makes what a deployment needs and nobody should have to type: the R2
 * buckets the Worker binds, and the secrets it uses.
 * - `CREDENTIALS_KEY`, which every member's sealed passwords are derived from, is made only for a
 *   Worker that has never been deployed. A deployed Worker without one stops the deploy, since a
 *   new key would leave every password it stored unreadable. The old key has to be restored.
 * - `PUSH_KEY`, the P-256 key that signs notifications, is made whenever the Worker has none.
 * - `VISITOR_KEY`, which signs the public demo's visitor cookies, is made whenever the demo has
 *   none. The demo stores no password and sends no notification, so it gets neither of the others.
 *
 * It passes on `ACCESS_API_TOKEN` when the environment has one, and names the commit and the
 * account. A deploy adds to the Worker's secrets and removes none, and it never prints a value.
 */

/** The secrets a deployment makes for itself. */
type MadeSecret = 'CREDENTIALS_KEY' | 'PUSH_KEY' | 'VISITOR_KEY';

/** A built Worker's configuration, as much of it as a deploy reads. */
export type Built = {
  name: string;
  r2_buckets?: { bucket_name: string }[];
  durable_objects?: { bindings?: { class_name: string }[] };
};

/** The secrets a Worker uses: the demo's, if it keeps the visitor gate, or a deployment's own. */
export function secretsUsedBy(built: Built): MadeSecret[] {
  const isDemo = built.durable_objects?.bindings?.some((b) => b.class_name === 'VisitorGate');
  return isDemo ? ['VISITOR_KEY'] : ['CREDENTIALS_KEY', 'PUSH_KEY'];
}

/** What the account holds of the Worker: whether it was ever deployed, and its secrets' names. */
export type WorkerOnAccount = { deployed: boolean; held: ReadonlySet<string> };

/** Runs Wrangler with these arguments, under Node, and says how it went. */
export type Wrangler = (
  args: readonly string[],
  env?: NodeJS.ProcessEnv,
) => Promise<{ status: number; stdout: string; stderr: string }>;

/** Why a deploy stopped before it changed anything. */
export class DeployStopped extends Error {}

/**
 * The secrets this deploy makes, of those the Worker uses: each one it lacks, except that a
 * deployed Worker without its `CREDENTIALS_KEY` stops the deploy.
 */
export function secretsToMake(
  { deployed, held }: WorkerOnAccount,
  used: readonly MadeSecret[],
): MadeSecret[] {
  if (used.includes('CREDENTIALS_KEY') && deployed && !held.has('CREDENTIALS_KEY')) {
    throw new DeployStopped(
      [
        'This Worker has been deployed before, but it has no CREDENTIALS_KEY secret, so nothing was deployed.',
        'A new key would leave every password it stored unreadable. Put the key it had back with',
        '`wrangler secret put CREDENTIALS_KEY`, then deploy again. If it never stored a password,',
        'any value of 32 or more random characters will do: `openssl rand -base64 48` makes one.',
      ].join('\n'),
    );
  }
  return used.filter((name) => !held.has(name));
}

/** A new value for a secret a deployment makes. */
export function mint(name: MadeSecret): string {
  if (name !== 'PUSH_KEY') return randomBytes(48).toString('base64');
  return generateKeyPairSync('ec', {
    namedCurve: 'P-256',
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  }).privateKey;
}

/**
 * Whether the Worker was ever deployed, and its secrets' names. Only Cloudflare saying there is no
 * such Worker counts as nothing held: any other failure stops the deploy, so a key that exists is
 * never taken for missing.
 */
export async function lookUp(worker: string, wrangler: Wrangler): Promise<WorkerOnAccount> {
  const deployments = await wrangler(['deployments', 'list', '--name', worker, '--json']);
  if (deployments.status !== 0) {
    if (/\[code: 10007\]/.test(deployments.stderr + deployments.stdout)) {
      return { deployed: false, held: new Set() };
    }
    throw new DeployStopped(`Couldn’t read ${worker}’s deployments:\n${deployments.stderr}`);
  }
  const listed = jsonOf(deployments.stdout, `${worker}’s deployments`);
  if (!Array.isArray(listed)) {
    throw new DeployStopped(`Wrangler listed ${worker}’s deployments in a shape it can’t read.`);
  }
  const secrets = await wrangler(['secret', 'list', '--name', worker, '--format', 'json']);
  if (secrets.status !== 0) {
    throw new DeployStopped(`Couldn’t read ${worker}’s secrets:\n${secrets.stderr}`);
  }
  const listing = jsonOf(secrets.stdout, `${worker}’s secrets`);
  const names = Array.isArray(listing)
    ? listing.map((each: unknown) => (each as { name?: unknown } | null)?.name)
    : [];
  if (!Array.isArray(listing) || !names.every((name) => typeof name === 'string')) {
    throw new DeployStopped(`Wrangler listed ${worker}’s secrets in a shape it can’t read.`);
  }
  return { deployed: listed.length > 0, held: new Set(names) };
}

/** Makes each R2 bucket the Worker binds that the account doesn't have yet. */
export async function makeBuckets(
  buckets: readonly string[],
  wrangler: Wrangler,
): Promise<string[]> {
  const made: string[] = [];
  for (const bucket of buckets) {
    const created = await wrangler(['r2', 'bucket', 'create', bucket]);
    if (created.status === 0) made.push(bucket);
    else if (!/\[code: 10004\]/.test(created.stderr + created.stdout)) {
      throw new DeployStopped(`Couldn’t make the R2 bucket ${bucket}:\n${created.stderr}`);
    }
  }
  return made;
}

/** The account to deploy to, as the environment names it or as the only one Wrangler can reach. */
export async function accountOf(
  env: NodeJS.ProcessEnv,
  wrangler: Wrangler,
): Promise<string | undefined> {
  if (env.CLOUDFLARE_ACCOUNT_ID) return env.CLOUDFLARE_ACCOUNT_ID;
  const whoami = await wrangler(['whoami', '--json']);
  if (whoami.status !== 0) return undefined;
  const accounts = (jsonOf(whoami.stdout, 'who Wrangler signed in as') as { accounts?: unknown[] })
    ?.accounts;
  const [only] = Array.isArray(accounts) && accounts.length === 1 ? accounts : [];
  return typeof (only as { id?: unknown })?.id === 'string'
    ? (only as { id: string }).id
    : undefined;
}

/** The commit being deployed, as CI names it or as a clean checkout is at, for `/health`. */
export function commitOf(env: NodeJS.ProcessEnv, git = gitCommit): string {
  return env.WORKERS_CI_COMMIT_SHA || env.GITHUB_SHA || git() || 'development';
}

type Deploy = {
  /** The built Worker's configuration. */
  config: string;
  /** More arguments for `wrangler deploy`, such as `--var NAME:value` or `--dry-run`. */
  args: readonly string[];
  env: NodeJS.ProcessEnv;
  wrangler: Wrangler;
  log: (line: string) => void;
};

export async function deploy({ config, args, env, wrangler, log }: Deploy): Promise<void> {
  const built = jsonOf(readFile(config), config) as Built;
  const worker = built.name;
  const account = await accountOf(env, wrangler);
  // Wrangler finds the account itself, unless it can reach several and must be told.
  const accountEnv = account ? { ...env, CLOUDFLARE_ACCOUNT_ID: account } : env;
  const run: Wrangler = (more, extra) => wrangler(more, extra ?? accountEnv);

  const found = await lookUp(worker, run);
  log(
    found.deployed
      ? `${worker} keeps its secrets: ${[...found.held].sort().join(', ') || 'none'}.`
      : `${worker} hasn’t been deployed yet.`,
  );
  const make = secretsToMake(found, secretsUsedBy(built));
  for (const bucket of await makeBuckets(
    (built.r2_buckets ?? []).map((b) => b.bucket_name),
    run,
  )) {
    log(`Made the R2 bucket ${bucket}.`);
  }

  const secrets: Record<string, string> = Object.fromEntries(
    make.map((name) => [name, mint(name)]),
  );
  if (env.ACCESS_API_TOKEN) secrets.ACCESS_API_TOKEN = env.ACCESS_API_TOKEN;
  if (make.length > 0) log(`This deploy makes ${make.join(' and ')}, once.`);

  const vars = ['--var', `VERSION:${commitOf(env)}`];
  if (account) vars.push('--var', `CLOUDFLARE_ACCOUNT_ID:${account}`);
  // Secrets reach Wrangler in a file only this user can read, never as an argument, and the
  // environment can't override them, as Wrangler would let it.
  const folder = mkdtempSync(join(tmpdir(), 'trail-mix-deploy-'));
  try {
    const file = join(folder, 'secrets.json');
    writeFileSync(file, JSON.stringify(secrets), { mode: 0o600 });
    const deployEnv = { ...accountEnv };
    for (const name of Object.keys(secrets)) delete deployEnv[name];
    const deployed = await run(
      ['deploy', '--config', config, ...vars, '--secrets-file', file, ...args],
      deployEnv,
    );
    process.stdout.write(deployed.stdout);
    process.stderr.write(deployed.stderr);
    if (deployed.status !== 0) throw new DeployStopped('Wrangler couldn’t deploy the Worker.');
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

/** Wrangler from this checkout, under Node. */
export const nodeWrangler: Wrangler = (args, env = process.env) =>
  new Promise((resolve, reject) => {
    const child = spawn('node', ['node_modules/wrangler/bin/wrangler.js', ...args], {
      env: { ...env, WRANGLER_SEND_METRICS: 'false' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
    child.on('error', reject);
    child.on('close', (status) => resolve({ status: status ?? 1, stdout, stderr }));
  });

function gitCommit(): string | undefined {
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' });
  const changed = spawnSync('git', ['status', '--porcelain'], { encoding: 'utf8' });
  if (head.status !== 0 || changed.status !== 0 || changed.stdout.trim()) return undefined;
  return head.stdout.trim();
}

function jsonOf(text: string, what: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new DeployStopped(`Wrangler’s answer about ${what} wasn’t JSON.`);
  }
}

function readFile(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    throw new DeployStopped(`There is no build at ${path}. Run \`bun run build\` first.`);
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const at = args.indexOf('--config');
  const config = at < 0 ? 'dist/server/wrangler.json' : args.splice(at, 2)[1]!;
  try {
    await deploy({
      config,
      args,
      env: process.env,
      wrangler: nodeWrangler,
      log: (line) => console.log(line),
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
