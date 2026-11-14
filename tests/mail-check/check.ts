// The mail check: lists folders, opens the newest message, sends to self as the Outbox sends and,
// with --watch-minutes, watches the Inbox that long before seeing new mail. It runs all of it in a
// Durable Object on the local Workers runtime, through the provider the Mailroom uses, so it tests
// what the Mailroom does on the runtime it runs on.
//
//   bun tests/mail-check/check.ts --preset zoho --user me@example.com
//   op read op://Private/Zoho/app-password | bun tests/mail-check/check.ts --preset zoho --user …
//   bun tests/mail-check/check.ts --preset outlook --user me@outlook.com --client-id <Entra app ID>
//   bun tests/mail-check/check.ts --preset test --user alice@trailmix.test    (the test mail server)
//
// --imap-host and --smtp-host replace the preset's server names, keeping its ports and TLS. Zoho's
// names depend on the account, so give the ones its settings list, such as imap.zoho.com and
// smtp.zoho.com.
//
// A password is read from the terminal with echo off, or from the first line of a pipe. It is never
// an argument or an environment variable, so it stays out of shell history and process listings.
// Outlook signs in with Microsoft's device-code flow instead, as the Mailroom does, and keeps only
// the access token. The secret reaches workerd in one request body over loopback, and nothing
// writes it to disk.
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import {
  PRESETS,
  codeFrom,
  codeRequest,
  pollRequest,
  polled,
  withStandIn,
  type DeviceSignIn,
  type Preset,
  type VendorRequest,
} from '../../src/features/providers/index.ts';
import { withoutSecrets } from '../../src/features/providers/imap/core/signin.ts';
import { caFile, identity, ports } from '../mail-server/server.ts';
import { startWorker } from '../workerd.ts';
import type { CheckRequest, CheckResult } from './worker.ts';

/** The test mail server: a host of its own, and one standing in for Outlook. */
const local = (port: number, secure: boolean) => ({ host: 'localhost', port, secure });
const TEST: Preset = {
  imap: local(ports.imaps, true),
  smtp: local(ports.submissions, true),
  filesSent: false,
  authServers: {},
};
const TEST_OUTLOOK = withStandIn(
  PRESETS.outlook,
  JSON.stringify({ ...TEST, authority: identity.authority, smtp: local(ports.submission, false) }),
);
const presets: Record<string, Preset> = { ...PRESETS, test: TEST, 'test-outlook': TEST_OUTLOOK };

/** Signs in at the vendor as the Mailroom does, showing the code, and resolves to an access token. */
async function signInWithDeviceCode(device: DeviceSignIn, clientId: string): Promise<string> {
  const ask = async ({ url, form }: VendorRequest) => {
    const response = await fetch(url, { method: 'POST', body: form });
    const body: unknown = await response.json().catch(() => null);
    return { status: response.status, body };
  };
  const client = { id: clientId };
  const started = codeFrom(device, await ask(codeRequest(device, client)), Date.now());
  console.error(`To sign in, open ${started.link} and enter the code ${started.code}.`);
  let interval = started.interval;
  while (Date.now() < started.expiresAt) {
    await Bun.sleep(interval);
    const poll = await ask(pollRequest(device, client, started.deviceCode));
    const result = polled(device, poll, interval, Date.now());
    if ('granted' in result) return result.granted.access;
    if ('refused' in result) throw new Error(result.refused);
    interval = result.pending;
  }
  throw new Error('The code expired before sign-in finished.');
}

// The command

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      preset: { type: 'string' },
      user: { type: 'string' },
      'client-id': { type: 'string' },
      'imap-host': { type: 'string' },
      'smtp-host': { type: 'string' },
      'watch-minutes': { type: 'string', default: '0' },
    },
  });
  const preset = presets[values.preset ?? ''];
  const user = values.user;
  const imapHost = values['imap-host'];
  const smtpHost = values['smtp-host'];
  if (!preset || !user) {
    console.error(
      `usage: bun tests/mail-check/check.ts --preset ${Object.keys(presets).join('|')} --user <address> [--imap-host <name>] [--smtp-host <name>] [--client-id <id>] [--watch-minutes 15.5]`,
    );
    process.exit(2);
  }

  const test = preset === TEST || preset === TEST_OUTLOOK;
  let secret: string;
  if (preset.device) {
    const clientId = values['client-id'] ?? (test ? 'trail-mix-test' : undefined);
    if (!clientId) {
      throw new Error(
        'Outlook needs --client-id, the Application ID of your Entra app registration.',
      );
    }
    secret = await signInWithDeviceCode(preset.device, clientId);
  } else {
    secret = await readSecret(`Password for ${user}: `);
  }

  const request: CheckRequest = {
    user,
    secret,
    oauth: Boolean(preset.device),
    imap: imapHost ? { ...preset.imap, host: imapHost } : preset.imap,
    smtp: smtpHost ? { ...preset.smtp, host: smtpHost } : preset.smtp,
    filesSent: preset.filesSent,
    watchSeconds: Math.round(Number(values['watch-minutes']) * 60),
  };
  process.exitCode = await runInWorkerd(request, test);
}

async function runInWorkerd(request: CheckRequest, test: boolean): Promise<number> {
  const workerd = await startWorker(
    {
      name: 'trail-mix-mail-check',
      main: join(import.meta.dir, 'worker.ts'),
      durable_objects: { bindings: [{ name: 'CHECK', class_name: 'Check' }] },
      migrations: [{ tag: 'v1', new_sqlite_classes: ['Check'] }],
    },
    // Trust the test mail server's certificate authority, which no real host needs.
    { env: test ? { NODE_EXTRA_CA_CERTS: caFile } : {} },
  );
  try {
    const response = await fetch(`${workerd.url}/run`, {
      method: 'POST',
      body: JSON.stringify(request),
    });
    // Belt and braces: nothing printed may carry the secret, as the provider's own refusals don't.
    const redact = (text: string) =>
      withoutSecrets(text, { user: request.user, secrets: [request.secret] });
    if (!response.ok || !response.body) {
      throw new Error(
        redact(`workerd answered ${response.status}: ${(await response.text()).slice(0, 500)}`),
      );
    }
    // One JSON line per check, printed as each one finishes. Blank lines only keep the response alive.
    const expected = request.watchSeconds > 0 ? 3 : 2;
    let [reported, failed] = [0, 0];
    let pending = '';
    // A workerd that stops resets the response, rather than ending it.
    let reset = '';
    try {
      for await (const chunk of response.body.pipeThrough(new TextDecoderStream())) {
        const lines = (pending + chunk).split('\n');
        pending = lines.pop() ?? '';
        for (const line of lines.filter(Boolean)) {
          const message = JSON.parse(line) as CheckResult | { runtime: string };
          if ('runtime' in message) {
            const hosts = new Set([request.imap.host, request.smtp.host]);
            console.log(
              `On ${message.runtime}, as ${request.user}, at ${[...hosts].join(' and ')}:`,
            );
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
    } catch (error) {
      reset = `: ${String(error)}`;
    }
    if (reported < expected) {
      console.log(redact(`FAIL workerd stopped after ${reported} of ${expected} checks${reset}`));
      return 1;
    }
    return failed ? 1 : 0;
  } finally {
    workerd.stop();
  }
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
