import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  commitOf,
  deploy,
  DeployStopped,
  lookUp,
  makeBuckets,
  mint,
  nodeWrangler,
  secretsToMake,
  secretsUsedBy,
  type Wrangler,
} from './deploy.ts';

describe('the secrets a deploy makes', () => {
  const found = (deployed: boolean, ...held: string[]) => ({ deployed, held: new Set(held) });
  const production = secretsUsedBy({ name: 'trail-mix' });

  test('are both, for a Worker never deployed', () => {
    expect(secretsToMake(found(false), production)).toEqual(['CREDENTIALS_KEY', 'PUSH_KEY']);
    // A Worker made by some other way first, with nothing deployed yet, still gets its key.
    expect(secretsToMake(found(false, 'PUSH_KEY'), production)).toEqual(['CREDENTIALS_KEY']);
  });

  test('are only a missing push key, for a deployed Worker that has its credentials key', () => {
    expect(secretsToMake(found(true, 'CREDENTIALS_KEY', 'PUSH_KEY'), production)).toEqual([]);
    expect(secretsToMake(found(true, 'CREDENTIALS_KEY', 'SOMETHING_ELSE'), production)).toEqual([
      'PUSH_KEY',
    ]);
  });

  test('never include a new credentials key for a Worker that has been deployed', () => {
    for (const held of [[], ['PUSH_KEY'], ['SOMETHING_ELSE', 'credentials_key']]) {
      expect(() => secretsToMake(found(true, ...held), production)).toThrow(DeployStopped);
    }
    expect(() => secretsToMake(found(true), production)).toThrow('Put the key it had back');
  });

  test('for the public demo are its visitor key alone, which it may make again', () => {
    const demo = secretsUsedBy({
      name: 'trail-mix-demo',
      durable_objects: { bindings: [{ class_name: 'Mailroom' }, { class_name: 'VisitorGate' }] },
    });
    expect(demo).toEqual(['VISITOR_KEY']);
    expect(secretsToMake(found(true), demo)).toEqual(['VISITOR_KEY']);
    expect(secretsToMake(found(true, 'VISITOR_KEY'), demo)).toEqual([]);
  });

  test('are made new each time, a credentials key long enough and a push key on P-256', async () => {
    const [key, again] = [mint('CREDENTIALS_KEY'), mint('CREDENTIALS_KEY')];
    expect(key.length).toBeGreaterThanOrEqual(32);
    expect(key).not.toBe(again);

    expect(mint('VISITOR_KEY').length).toBeGreaterThanOrEqual(32);
    const pem = mint('PUSH_KEY');
    expect(pem).toStartWith('-----BEGIN PRIVATE KEY-----');
    expect(pem).not.toBe(mint('PUSH_KEY'));
    // As the Worker reads it.
    const der = Uint8Array.from(atob(pem.replace(/-----[^-]+-----|\s/g, '')), (c) =>
      c.charCodeAt(0),
    );
    const imported = await crypto.subtle.importKey(
      'pkcs8',
      der,
      { name: 'ECDSA', namedCurve: 'P-256' },
      true,
      ['sign'],
    );
    expect((imported.algorithm as EcKeyAlgorithm).namedCurve).toBe('P-256');
  });
});

test('the commit /health names is CI’s, else a clean checkout’s, else development', () => {
  expect(commitOf({ WORKERS_CI_COMMIT_SHA: 'a1', GITHUB_SHA: 'b2' }, () => 'c3')).toBe('a1');
  expect(commitOf({ GITHUB_SHA: 'b2' }, () => 'c3')).toBe('b2');
  expect(commitOf({}, () => 'c3')).toBe('c3');
  expect(commitOf({}, () => undefined)).toBe('development');
});

/**
 * Cloudflare's API as Wrangler reaches it, holding Workers by name: how many deployments each has
 * had and its secrets' names. Each request is recorded.
 */
type Held = { deployments: number; secrets: string[] };
const workers = new Map<string, Held>();
const buckets = new Set<string>();
const asked: string[] = [];
let failing: RegExp | undefined;
let cloudflare: ReturnType<typeof Bun.serve>;
let folder: string;

const failure = (status: number, code: number, message: string) =>
  Response.json(
    { success: false, errors: [{ code, message }], messages: [], result: null },
    { status },
  );
const success = (result: unknown) =>
  Response.json({ success: true, errors: [], messages: [], result });

beforeAll(() => {
  folder = mkdtempSync(join(tmpdir(), 'trail-mix-deploy-test-'));
  cloudflare = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(request) {
      const { pathname } = new URL(request.url);
      asked.push(`${request.method} ${pathname.replace(/^\/client\/v4\/accounts\/[^/]+/, '')}`);
      if (failing?.test(pathname)) return failure(500, 10000, 'Something went wrong.');
      if (request.method === 'POST' && pathname.endsWith('/r2/buckets')) {
        const { name } = (await request.json()) as { name: string };
        if (buckets.has(name)) return failure(409, 10004, 'That bucket already exists.');
        buckets.add(name);
        return success({ name });
      }
      const [, name, what] =
        /\/workers\/scripts\/([^/]+)\/(deployments|secrets)$/.exec(pathname) ?? [];
      const worker = name === undefined ? undefined : workers.get(name);
      if (!what) return failure(404, 7003, 'No route for that URI.');
      if (!worker) return failure(404, 10007, 'This Worker does not exist on your account.');
      if (what === 'secrets') {
        return success(worker.secrets.map((secret) => ({ name: secret, type: 'secret_text' })));
      }
      return success({
        deployments: Array.from({ length: worker.deployments }, (_, i) => ({
          id: `d${i}`,
          source: 'wrangler',
          strategy: 'percentage',
          author_email: 'ada@example.com',
          created_on: '2026-11-10T00:00:00Z',
          versions: [{ version_id: `v${i}`, percentage: 100 }],
          annotations: {},
        })),
      });
    },
  });
});

afterAll(async () => {
  await cloudflare.stop(true);
  rmSync(folder, { recursive: true, force: true });
});

/** Wrangler under Node, reaching the stand-in for Cloudflare, as a deploy with a token would. */
const wrangler: Wrangler = (args, env = {}) =>
  nodeWrangler(args, {
    PATH: process.env.PATH,
    HOME: folder,
    ...env,
    CLOUDFLARE_API_BASE_URL: `${cloudflare.url.origin}/client/v4`,
    CLOUDFLARE_API_TOKEN: 'a-token',
    CLOUDFLARE_ACCOUNT_ID: 'an-account',
  });

function given(state: Record<string, Held>) {
  workers.clear();
  buckets.clear();
  asked.length = 0;
  failing = undefined;
  for (const [name, held] of Object.entries(state)) workers.set(name, held);
}

describe('what the account holds, as Wrangler reads it', () => {
  test('any other failure stops the deploy, rather than take a key for missing', async () => {
    given({ 'trail-mix': { deployments: 1, secrets: ['CREDENTIALS_KEY'] } });
    failing = /\/deployments$/;
    await expect(lookUp('trail-mix', wrangler)).rejects.toThrow(
      'Couldn’t read trail-mix’s deployments',
    );
    failing = /\/secrets$/;
    await expect(lookUp('trail-mix', wrangler)).rejects.toThrow(
      'Couldn’t read trail-mix’s secrets',
    );
  }, 30_000);

  test('a bucket the account lacks is made, and one it has is left alone', async () => {
    given({});
    buckets.add('trail-mix-bodies');
    expect(await makeBuckets(['trail-mix-bodies', 'trail-mix-more'], wrangler)).toEqual([
      'trail-mix-more',
    ]);
    failing = /\/r2\/buckets$/;
    await expect(makeBuckets(['trail-mix-other'], wrangler)).rejects.toThrow(
      'Couldn’t make the R2 bucket',
    );
  }, 30_000);
});

describe('a deploy', () => {
  /** Each deploy Wrangler ran: its arguments and environment, and the secrets file it was given. */
  const deploys: {
    args: string[];
    env: NodeJS.ProcessEnv;
    secrets: Record<string, string>;
    mode: number;
  }[] = [];
  /** What the deploy logged. */
  const lines: string[] = [];

  /** Deploys a Worker named `name`, built as the Vite plugin writes one, to an account holding `state`. */
  function deploying(
    state: Record<string, Held>,
    name: string,
    { args = ['--dry-run'], env = {}, more = {} } = {},
  ) {
    given(state);
    deploys.length = 0;
    lines.length = 0;
    const dir = mkdtempSync(join(folder, 'built-'));
    writeFileSync(
      join(dir, 'index.js'),
      'export class VisitorGate {}\nexport default { fetch: () => new Response("ok") };',
    );
    writeFileSync(
      join(dir, 'wrangler.json'),
      JSON.stringify({
        name,
        main: 'index.js',
        compatibility_date: '2026-11-03',
        r2_buckets: [{ binding: 'BODIES', bucket_name: `${name}-bodies` }],
        ...more,
      }),
    );
    return deploy({
      config: join(dir, 'wrangler.json'),
      args,
      env,
      wrangler: (args, env) => {
        if (args[0] === 'deploy') {
          const file = args[args.indexOf('--secrets-file') + 1]!;
          deploys.push({
            args: [...args],
            env: env ?? {},
            secrets: JSON.parse(readFileSync(file, 'utf8')) as Record<string, string>,
            mode: statSync(file).mode & 0o777,
          });
        }
        return wrangler(args, env);
      },
      log: (line) => lines.push(line),
    });
  }

  test('of a new Worker makes both keys and its bucket, and deploys it', async () => {
    await deploying({}, 'trail-mix', {
      args: ['--dry-run', '--message', 'Commit a1'],
      env: { WORKERS_CI_COMMIT_SHA: 'a1' },
    });

    expect(buckets).toEqual(new Set(['trail-mix-bodies']));
    const [made] = deploys;
    expect(Object.keys(made!.secrets).sort()).toEqual(['CREDENTIALS_KEY', 'PUSH_KEY']);
    expect(made!.mode).toBe(0o600);
    expect(made!.args).toContain('VERSION:a1');
    expect(made!.args.slice(-3)).toEqual(['--dry-run', '--message', 'Commit a1']);
    // No secret is an argument, a line of the log, or in the environment Wrangler deploys with.
    const told = JSON.stringify([made!.args, lines, made!.env]);
    for (const value of Object.values(made!.secrets)) expect(told).not.toContain(value);
    // The secrets file is gone once the deploy is.
    expect(existsSync(made!.args[made!.args.indexOf('--secrets-file') + 1]!)).toBe(false);
    expect(lines).toContain('This deploy makes CREDENTIALS_KEY and PUSH_KEY, once.');
  }, 60_000);

  test('of a deployed Worker keeps its keys, and says which it kept', async () => {
    await deploying(
      { 'trail-mix': { deployments: 2, secrets: ['CREDENTIALS_KEY', 'PUSH_KEY'] } },
      'trail-mix',
    );

    expect(deploys[0]!.secrets).toEqual({});
    expect(lines).toContain('trail-mix keeps its secrets: CREDENTIALS_KEY, PUSH_KEY.');
  }, 60_000);

  test('of a deployed Worker without its credentials key changes nothing at all', async () => {
    // Its secrets come back empty, and it still counts as deployed.
    const stopped = deploying({ 'trail-mix': { deployments: 2, secrets: [] } }, 'trail-mix', {
      args: [],
    });
    await expect(stopped).rejects.toThrow(DeployStopped);

    expect(deploys).toEqual([]);
    expect(buckets).toEqual(new Set());
    expect(asked.filter((request) => !request.startsWith('GET'))).toEqual([]);
  }, 60_000);

  test('of a copy under another name makes keys for that Worker alone', async () => {
    await deploying(
      { 'trail-mix': { deployments: 2, secrets: ['CREDENTIALS_KEY', 'PUSH_KEY'] } },
      'my-mail',
    );

    expect(Object.keys(deploys[0]!.secrets).sort()).toEqual(['CREDENTIALS_KEY', 'PUSH_KEY']);
    expect(asked.filter((request) => request.includes('/workers/scripts/'))).toEqual([
      'GET /workers/scripts/my-mail/deployments',
    ]);
  }, 60_000);

  test('of the public demo makes its visitor key, and no key for passwords', async () => {
    await deploying({ 'trail-mix-demo': { deployments: 4, secrets: [] } }, 'trail-mix-demo', {
      more: {
        durable_objects: { bindings: [{ name: 'VISITORS', class_name: 'VisitorGate' }] },
        migrations: [{ tag: 'v1', new_sqlite_classes: ['VisitorGate'] }],
      },
    });

    expect(Object.keys(deploys[0]?.secrets ?? {})).toEqual(['VISITOR_KEY']);
  }, 60_000);
});
