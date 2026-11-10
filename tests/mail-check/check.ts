// The mail check: lists folders, fetches a message, submits over each of the host's submission
// ports and, with --watch-minutes, holds IDLE that long before seeing new mail. It runs all of it in
// a Durable Object on the local Workers runtime, so it tests the runtime the Mailroom runs on.
//
//   bun tests/mail-check/check.ts --preset zoho --user me@example.com
//   op read op://Private/Zoho/app-password | bun tests/mail-check/check.ts --preset zoho --user …
//   bun tests/mail-check/check.ts --preset outlook --user me@outlook.com --client-id <Entra app ID>
//   bun tests/mail-check/check.ts --preset test --user alice@trailmix.test    (the test mail server)
//
// A password is read from the terminal with echo off, or from the first line of a pipe. It is never
// an argument or an environment variable, so it stays out of shell history and process listings.
// Outlook signs in with Microsoft's device-code flow instead, and no refresh token is requested.
// The secret reaches workerd in one request body over loopback, and nothing writes it to disk.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import shellConfig from '../../wrangler.jsonc';
import { caFile, identity, ports } from '../mail-server/server.ts';
import type { CheckRequest, CheckResult, Endpoint } from './worker.ts';

const shell = shellConfig as { compatibility_date: string; compatibility_flags: string[] };

type Preset = {
  imap: Endpoint;
  smtp: Endpoint[];
  /** Microsoft's sign-in, for presets that use OAuth instead of a password. */
  authority?: string;
  /** Trust the test mail server's certificate authority, which no real host needs. */
  test?: boolean;
};

const at = (host: string, port: number): Endpoint => ({
  host,
  port,
  secure: port === 993 || port === 465 || port === ports.imaps || port === ports.submissions,
});

export const presets: Record<string, Preset> = {
  // Zoho accounts on a domain of their own. Addresses at zoho.com use imap.zoho.com and smtp.zoho.com.
  zoho: {
    imap: at('imappro.zoho.com', 993),
    smtp: [at('smtppro.zoho.com', 465), at('smtppro.zoho.com', 587)],
  },
  outlook: {
    imap: at('outlook.office365.com', 993),
    smtp: [at('smtp-mail.outlook.com', 587)],
    authority: 'https://login.microsoftonline.com/consumers',
  },
  test: {
    imap: at('localhost', ports.imaps),
    smtp: [at('localhost', ports.submissions), at('localhost', ports.submission)],
    test: true,
  },
  'test-outlook': {
    imap: at('localhost', ports.imaps),
    smtp: [at('localhost', ports.submission)],
    authority: identity.authority,
    test: true,
  },
};

/** What Trail Mix asks Microsoft for: IMAP and SMTP as the signed-in person, and nothing else. */
export const outlookScopes = [
  'https://outlook.office.com/IMAP.AccessAsUser.All',
  'https://outlook.office.com/SMTP.Send',
];

/**
 * Signs in with Microsoft's device-code flow (RFC 8628): asks for a code, shows it, and polls until
 * the person has signed in elsewhere. Resolves to an access token, and keeps nothing else.
 */
export async function signInWithDeviceCode(options: {
  authority: string;
  clientId: string;
  scopes: string[];
  show: (message: string) => void;
  sleep?: (ms: number) => Promise<void>;
}): Promise<string> {
  const { authority, clientId, scopes, show, sleep = Bun.sleep } = options;
  const post = async (path: string, form: Record<string, string>) => {
    const response = await fetch(`${authority}/oauth2/v2.0/${path}`, {
      method: 'POST',
      body: new URLSearchParams(form),
    });
    return { ok: response.ok, body: (await response.json()) as Record<string, unknown> };
  };

  const code = await post('devicecode', { client_id: clientId, scope: scopes.join(' ') });
  if (!code.ok) throw new Error(`Microsoft refused to start sign-in: ${describe(code.body)}`);
  const deviceCode = String(code.body.device_code);
  let interval = Number(code.body.interval ?? 5) * 1000;
  const deadline = Date.now() + Number(code.body.expires_in ?? 900) * 1000;
  show(String(code.body.message));

  while (Date.now() < deadline) {
    await sleep(interval);
    const token = await post('token', {
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      client_id: clientId,
      device_code: deviceCode,
    });
    if (token.ok) return String(token.body.access_token);
    switch (token.body.error) {
      case 'authorization_pending':
        continue;
      case 'slow_down':
        interval += 5000;
        continue;
      case 'authorization_declined':
        throw new Error('Sign-in was declined.');
      case 'expired_token':
        throw new Error('The code expired before sign-in finished.');
      default:
        throw new Error(`Microsoft refused the sign-in: ${describe(token.body)}`);
    }
  }
  throw new Error('The code expired before sign-in finished.');
}

function describe(body: Record<string, unknown>) {
  const reason = body.error_description ?? body.error;
  return typeof reason === 'string' ? reason : 'no reason given';
}

// The command

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      preset: { type: 'string' },
      user: { type: 'string' },
      'client-id': { type: 'string' },
      'watch-minutes': { type: 'string', default: '0' },
    },
  });
  const preset = presets[values.preset ?? ''];
  const user = values.user;
  if (!preset || !user) {
    console.error(
      `usage: bun tests/mail-check/check.ts --preset ${Object.keys(presets).join('|')} --user <address> [--client-id <id>] [--watch-minutes 15.5]`,
    );
    process.exit(2);
  }

  let secret: string;
  if (preset.authority) {
    const clientId = values['client-id'] ?? (preset.test ? 'trail-mix-test' : undefined);
    if (!clientId)
      throw new Error(
        'Outlook needs --client-id, the Application ID of your Entra app registration.',
      );
    secret = await signInWithDeviceCode({
      authority: preset.authority,
      clientId,
      scopes: outlookScopes,
      show: (m) => console.error(m),
    });
  } else {
    secret = await readSecret(`Password for ${user}: `);
  }

  const request: CheckRequest = {
    user,
    secret,
    auth: preset.authority ? 'oauth' : 'password',
    imap: preset.imap,
    smtp: preset.smtp,
    watchSeconds: Math.round(Number(values['watch-minutes']) * 60),
  };
  process.exitCode = await runInWorkerd(request, preset);
}

async function runInWorkerd(request: CheckRequest, preset: Preset): Promise<number> {
  const scratch = mkdtempSync(join(tmpdir(), 'trail-mix-check-'));
  // The check runs with the shell's own compatibility date and flags, so it tests the same runtime.
  writeFileSync(
    join(scratch, 'wrangler.json'),
    JSON.stringify({
      name: 'trail-mix-mail-check',
      main: join(import.meta.dir, 'worker.ts'),
      compatibility_date: shell.compatibility_date,
      compatibility_flags: shell.compatibility_flags,
      durable_objects: { bindings: [{ name: 'CHECK', class_name: 'Check' }] },
      migrations: [{ tag: 'v1', new_sqlite_classes: ['Check'] }],
    }),
  );
  const port = await freePort();
  // Node starts workerd, because Miniflare cannot reach it under Bun (oven-sh/bun#39247).
  const workerd = spawn(
    'node',
    [
      join(import.meta.dir, '../../node_modules/wrangler/bin/wrangler.js'),
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
      'error',
    ],
    {
      cwd: scratch,
      detached: true,
      stdio: 'ignore',
      env: {
        ...process.env,
        // Wrangler otherwise keeps a debug log of every run in its own folder.
        WRANGLER_WRITE_LOGS: 'false',
        WRANGLER_SEND_METRICS: 'false',
        ...(preset.test ? { NODE_EXTRA_CA_CERTS: caFile } : {}),
      },
    },
  );
  try {
    await until(`http://127.0.0.1:${port}/`);
    const response = await fetch(`http://127.0.0.1:${port}/run`, {
      method: 'POST',
      body: JSON.stringify(request),
    });
    const redact = redactor(request);
    if (!response.ok || !response.body) {
      throw new Error(
        redact(`workerd answered ${response.status}: ${(await response.text()).slice(0, 500)}`),
      );
    }
    // One JSON line per check, printed as each one finishes. Blank lines only keep the response alive.
    const expected = 1 + request.smtp.length + (request.watchSeconds > 0 ? 1 : 0);
    let [reported, failed] = [0, 0];
    let pending = '';
    for await (const chunk of response.body.pipeThrough(new TextDecoderStream())) {
      const lines = (pending + chunk).split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines.filter(Boolean)) {
        const message = JSON.parse(line) as CheckResult | { runtime: string };
        if ('runtime' in message) {
          console.log(`On ${message.runtime}, as ${request.user}:`);
          continue;
        }
        reported++;
        if (!message.ok) failed++;
        const outcome = message.ok ? JSON.stringify(message.detail) : message.error;
        console.log(
          redact(
            `${message.ok ? 'PASS' : 'FAIL'} ${`${message.ms}ms`.padStart(8)}  ${message.check}  ${outcome}`,
          ),
        );
      }
    }
    if (reported < expected) {
      console.log(`FAIL workerd stopped after ${reported} of ${expected} checks`);
      return 1;
    }
    return failed ? 1 : 0;
  } finally {
    if (workerd.pid) process.kill(-workerd.pid, 'SIGKILL');
    rmSync(scratch, { recursive: true, force: true });
  }
}

// Belt and braces: nothing printed may carry the secret, plainly or in the encodings logins use.
function redactor({ user, secret }: CheckRequest) {
  const forms = [
    secret,
    btoa(secret),
    btoa(`\0${user}\0${secret}`),
    btoa(`user=${user}\x01auth=Bearer ${secret}\x01\x01`),
  ];
  return (text: string) => forms.reduce((out, form) => out.split(form).join('[redacted]'), text);
}

async function readSecret(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) {
    const piped = await new Response(Bun.stdin.stream()).text();
    return piped.split(/\r?\n/)[0] ?? '';
  }
  process.stderr.write(prompt);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return await new Promise((resolve) => {
    let value = '';
    const onData = (chunk: Buffer) => {
      for (const char of chunk.toString('utf8')) {
        if (char === '\u0003') process.exit(130);
        if (char === '\r' || char === '\n') {
          process.stdin.setRawMode(false);
          process.stdin.pause();
          process.stdin.off('data', onData);
          process.stderr.write('\n');
          resolve(value);
          return;
        }
        value = char === '\u007f' ? value.slice(0, -1) : value + char;
      }
    };
    process.stdin.on('data', onData);
  });
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
