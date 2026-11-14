import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  accountOf,
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
    expect(secretsToMake(found(true, 'CREDENTIALS_KEY', 'ACCESS_API_TOKEN'), production)).toEqual([
      'PUSH_KEY',
    ]);
  });

  test('never include a new credentials key for a Worker that has been deployed', () => {
    for (const held of [[], ['PUSH_KEY'], ['ACCESS_API_TOKEN', 'credentials_key']]) {
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
    expect(secretsUsedBy({ name: 'trail-mix' })).toEqual(['CREDENTIALS_KEY', 'PUSH_KEY']);
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

test('the account is the environment’s, or the only one Wrangler reaches', async () => {
  const whoami =
    (accounts: unknown[]): Wrangler =>
    () =>
      Promise.resolve({
        status: 0,
        stdout: JSON.stringify({ loggedIn: true, accounts }),
        stderr: '',
      });
  expect(await accountOf({ CLOUDFLARE_ACCOUNT_ID: 'mine' }, whoami([]))).toBe('mine');
  expect(await accountOf({}, whoami([{ id: 'only', name: 'Mine' }]))).toBe('only');
  expect(await accountOf({}, whoami([{ id: 'a' }, { id: 'b' }]))).toBeUndefined();
  const signedOut: Wrangler = () =>
    Promise.resolve({ status: 1, stdout: '', stderr: 'Not logged in' });
  expect(await accountOf({}, signedOut)).toBeUndefined();
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
      const bucket = /\/r2\/buckets$/.exec(pathname);
      if (bucket && request.method === 'POST') {
        const { name } = (await request.json()) as { name: string };
        if (buckets.has(name)) {
          return failure(
            409,
            10004,
            'The bucket you tried to create already exists, and you own it.',
          );
        }
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
  test('a Worker Cloudflare has never heard of holds nothing and was never deployed', async () => {
    given({});
    expect(await lookUp('trail-mix', wrangler)).toEqual({ deployed: false, held: new Set() });
  }, 30_000);

  test('a deployed Worker’s secrets are its own, read by its name', async () => {
    given({
      'trail-mix': { deployments: 3, secrets: ['CREDENTIALS_KEY', 'PUSH_KEY'] },
      other: { deployments: 1, secrets: ['SOMETHING_ELSE'] },
    });
    expect(await lookUp('trail-mix', wrangler)).toEqual({
      deployed: true,
      held: new Set(['CREDENTIALS_KEY', 'PUSH_KEY']),
    });
    expect(asked).toEqual([
      'GET /workers/scripts/trail-mix/deployments',
      'GET /workers/scripts/trail-mix/secrets',
    ]);
  }, 30_000);

  test('a deployed Worker whose secrets come back empty stops the deploy', async () => {
    given({ 'trail-mix': { deployments: 1, secrets: [] } });
    const found = await lookUp('trail-mix', wrangler);
    expect(found).toEqual({ deployed: true, held: new Set() });
    expect(() => secretsToMake(found, secretsUsedBy({ name: 'trail-mix' }))).toThrow(DeployStopped);
  }, 30_000);

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
  /** A built Worker's configuration, as the Vite plugin writes one, named `name`. */
  function built(name: string, more: object = {}): string {
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
    return join(dir, 'wrangler.json');
  }

  /** Wrangler, recording each deploy's arguments, environment and the secrets file it was given. */
  function recording() {
    const deploys: {
      args: string[];
      env: NodeJS.ProcessEnv;
      secrets: Record<string, string>;
      mode: number;
    }[] = [];
    const run: Wrangler = (args, env) => {
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
    };
    return { run, deploys };
  }

  test('of a new Worker makes both keys and its bucket, and deploys it', async () => {
    given({});
    const { run, deploys } = recording();
    const lines: string[] = [];
    await deploy({
      config: built('trail-mix'),
      args: ['--dry-run', '--message', 'Commit a1'],
      env: {
        WORKERS_CI_COMMIT_SHA: 'a1',
        ACCESS_API_TOKEN: 'members-token',
        CLOUDFLARE_ACCOUNT_ID: 'an-account',
      },
      wrangler: run,
      log: (line) => lines.push(line),
    });

    expect(buckets).toEqual(new Set(['trail-mix-bodies']));
    const [made] = deploys;
    expect(Object.keys(made!.secrets).sort()).toEqual([
      'ACCESS_API_TOKEN',
      'CREDENTIALS_KEY',
      'PUSH_KEY',
    ]);
    expect(made!.secrets.ACCESS_API_TOKEN).toBe('members-token');
    expect(made!.mode).toBe(0o600);
    expect(made!.args).toContain('VERSION:a1');
    expect(made!.args).toContain('CLOUDFLARE_ACCOUNT_ID:an-account');
    expect(made!.args.slice(-3)).toEqual(['--dry-run', '--message', 'Commit a1']);
    // No secret is an argument, a line of the log, or in the environment Wrangler deploys with.
    const told = JSON.stringify([made!.args, lines, made!.env]);
    for (const value of Object.values(made!.secrets)) expect(told).not.toContain(value);
    // The secrets file is gone once the deploy is.
    expect(existsSync(made!.args[made!.args.indexOf('--secrets-file') + 1]!)).toBe(false);
    expect(lines).toContain('This deploy makes CREDENTIALS_KEY and PUSH_KEY, once.');
  }, 60_000);

  test('of a deployed Worker keeps its keys, and says which it kept', async () => {
    given({ 'trail-mix': { deployments: 2, secrets: ['CREDENTIALS_KEY', 'PUSH_KEY'] } });
    const { run, deploys } = recording();
    const lines: string[] = [];
    await deploy({
      config: built('trail-mix'),
      args: ['--dry-run'],
      env: {},
      wrangler: run,
      log: (line) => lines.push(line),
    });

    expect(deploys[0]!.secrets).toEqual({});
    expect(lines).toContain('trail-mix keeps its secrets: CREDENTIALS_KEY, PUSH_KEY.');
  }, 60_000);

  test('of a deployed Worker without its credentials key changes nothing at all', async () => {
    given({ 'trail-mix': { deployments: 2, secrets: ['PUSH_KEY'] } });
    const { run, deploys } = recording();
    await expect(
      deploy({ config: built('trail-mix'), args: [], env: {}, wrangler: run, log: () => {} }),
    ).rejects.toThrow(DeployStopped);

    expect(deploys).toEqual([]);
    expect(buckets).toEqual(new Set());
    expect(asked.filter((request) => !request.startsWith('GET'))).toEqual([]);
  }, 60_000);

  test('of a copy under another name makes keys for that Worker alone', async () => {
    given({ 'trail-mix': { deployments: 2, secrets: ['CREDENTIALS_KEY', 'PUSH_KEY'] } });
    const { run, deploys } = recording();
    await deploy({
      config: built('my-mail'),
      args: ['--dry-run'],
      env: {},
      wrangler: run,
      log: () => {},
    });

    expect(Object.keys(deploys[0]!.secrets).sort()).toEqual(['CREDENTIALS_KEY', 'PUSH_KEY']);
    expect(asked.filter((request) => request.includes('/workers/scripts/'))).toEqual([
      'GET /workers/scripts/my-mail/deployments',
    ]);
  }, 60_000);

  test('of the public demo makes its visitor key, and no key for passwords', async () => {
    given({ 'trail-mix-demo': { deployments: 4, secrets: [] } });
    const { run, deploys } = recording();
    await deploy({
      config: built('trail-mix-demo', {
        durable_objects: { bindings: [{ name: 'VISITORS', class_name: 'VisitorGate' }] },
        migrations: [{ tag: 'v1', new_sqlite_classes: ['VisitorGate'] }],
      }),
      args: ['--dry-run'],
      env: {},
      wrangler: run,
      log: () => {},
    });

    expect(Object.keys(deploys[0]?.secrets ?? {})).toEqual(['VISITOR_KEY']);
  }, 60_000);
});
