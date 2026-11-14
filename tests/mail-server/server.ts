// The test mail server. Dovecot 2.4 serves IMAP and takes local delivery over LMTP. One Bun
// process serves submission on implicit TLS and STARTTLS, delivering into Dovecot, and stands in
// for Microsoft's sign-in so the OAuth path can be exercised. Everything binds to loopback, nothing
// runs as root, and nothing can reach another mail host.
//
//   bun tests/mail-server/server.ts start [--profile full|zoho|outlook|plain]
//   bun tests/mail-server/server.ts stop | status | clean

import { $ } from 'bun';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir, userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import type { SMTPServerAuthentication } from 'smtp-server';
import { signInStandIn as standIn } from './sign-in.ts';

export const domain = 'trailmix.test';

export const users = {
  alice: { email: `alice@${domain}`, password: 'alice-test-password' },
  bob: { email: `bob@${domain}`, password: 'bob-test-password' },
  // The bench's mailbox, which holds 50,000 messages between runs, so no test empties it.
  bench: { email: `bench@${domain}`, password: 'bench-test-password' },
} as const;

/**
 * The ports, the standard ones moved up by MAIL_SERVER_PORTS, 3000 unless set. Checkouts that set
 * different values run their own servers side by side.
 */
const base = Number(process.env.MAIL_SERVER_PORTS ?? 3000);
export const ports = {
  imap: base + 143, // STARTTLS
  imaps: base + 993, // implicit TLS
  submission: base + 587, // STARTTLS
  submissions: base + 465, // implicit TLS
  lmtp: base + 24, // local delivery into Dovecot
  identity: base + 80, // the stand-in for Microsoft's sign-in
  webmail: base + 880, // Roundcube, for tests that read mail as another client shows it
};

/**
 * The stand-in for login.microsoftonline.com, for the device-code flow and XOAUTH2. `sign-in.ts`
 * says what it answers, and how a test plays the person and steers the sign-in.
 */
export const identity = {
  origin: `http://127.0.0.1:${ports.identity}`,
  authority: `http://127.0.0.1:${ports.identity}/consumers`,
} as const;

/**
 * Capabilities each profile withholds, so code cannot lean on what Zoho and Outlook lack. Zoho also
 * marks no folder with a role, so roles must be found some other way. `plain` is any IMAP server,
 * with IDLE and none of the extensions Trail Mix can do without. Zoho and Outlook file their own copy
 * of what they accept in Sent, so their submission does too, unless a test says otherwise.
 */
export const profiles = {
  full: { withhold: [], roleFlags: true, filesSent: false },
  zoho: {
    withhold: [
      'QRESYNC',
      'SPECIAL-USE',
      'SORT',
      'SORT=DISPLAY',
      'THREAD=REFERENCES',
      'THREAD=REFS',
      'THREAD=ORDEREDSUBJECT',
    ],
    roleFlags: false,
    filesSent: true,
  },
  outlook: { withhold: ['CONDSTORE', 'QRESYNC'], roleFlags: true, filesSent: true },
  plain: {
    withhold: [
      'UIDPLUS',
      'MOVE',
      'CONDSTORE',
      'QRESYNC',
      'SPECIAL-USE',
      'SORT',
      'SORT=DISPLAY',
      'THREAD=REFERENCES',
      'THREAD=REFS',
      'THREAD=ORDEREDSUBJECT',
    ],
    roleFlags: false,
    filesSent: false,
  },
} as const;
export type Profile = keyof typeof profiles;

const root = join(import.meta.dir, '../../.mail-server');
const state = join(root, 'state');
const tls = join(state, 'tls');
const conf = join(state, 'dovecot.conf');
// Unix socket paths are capped near 104 bytes, so Dovecot's runtime directory stays short.
const run = join(
  tmpdir().startsWith('/var/') ? '/tmp' : tmpdir(),
  `trail-mix-mail-${userInfo().uid}-${base}`,
);

/** The certificate authority clients trust to reach this server, as they trust a real host's. */
export const caFile = join(tls, 'ca.crt');

// Starting

export async function start(profile: Profile = 'full') {
  const binaries = await dovecot();
  await stop();
  try {
    await launch(binaries, profile);
  } catch (error) {
    // Leave nothing half-started behind, so the next start finds its ports free.
    await stop();
    throw error;
  }
}

async function launch(binaries: Dovecot, profile: Profile) {
  mkdirSync(join(state, 'mail'), { recursive: true });
  await certificates();
  writeFileSync(join(state, 'users'), passwd());
  writeFileSync(conf, config(profile));
  writeFileSync(join(state, 'profile'), profile);

  rmSync(join(state, 'serve.ready'), { force: true });
  rmSync(join(state, 'paused'), { recursive: true, force: true });
  rmSync(join(state, 'no-submission'), { recursive: true, force: true });
  rmSync(join(state, 'filing'), { recursive: true, force: true });
  // Started by a shell that exits at once, so that, as Dovecot does, the server runs on its own and
  // records its own pid. When a test times out, Bun ends the processes its tests and hooks
  // started, and a server started from a harness's hook would go with them.
  const launcher = spawn(
    '/bin/sh',
    [
      '-c',
      '"$0" "$1" serve >>"$2" 2>&1 </dev/null &',
      process.execPath,
      import.meta.path,
      join(state, 'serve.log'),
    ],
    { detached: true, stdio: 'ignore' },
  );
  await new Promise((resolve) => launcher.once('exit', resolve));

  // Dovecot daemonizes, and its children would hold any pipe open, so its output goes to a file.
  const startup = join(state, 'startup.log');
  const master = Bun.spawnSync([binaries.dovecot, '-c', conf], {
    stdio: ['ignore', openSync(startup, 'w'), openSync(startup, 'a')],
  });
  if (master.exitCode !== 0)
    throw new Error(`Dovecot did not start:\n${readFileSync(startup, 'utf8')}`);

  await until(
    () => existsSync(join(state, 'serve.ready')),
    'the submission server',
    join(state, 'serve.log'),
  );
  await until(imapGreets, 'Dovecot', join(state, 'dovecot.log'));
}

export async function stop() {
  const pidFile = join(state, 'serve.pid');
  if (existsSync(pidFile)) {
    try {
      process.kill(Number(readFileSync(pidFile, 'utf8')));
    } catch {
      // Already gone.
    }
    rmSync(pidFile);
  }
  if (!existsSync(join(run, 'master.pid'))) return;
  const { dovecot: binary } = await dovecot();
  Bun.spawnSync([binary, '-c', conf, 'stop']);
  for (let i = 0; i < 50 && existsSync(join(run, 'master.pid')); i++) await Bun.sleep(100);
}

export function running(): Profile | null {
  if (!existsSync(join(run, 'master.pid'))) return null;
  return readFileSync(join(state, 'profile'), 'utf8') as Profile;
}

/** Drops every IMAP connection of a user, as a server restart or a network blip would. */
export async function kick(user: string) {
  await $`${(await dovecot()).doveadm} -c ${conf} kick ${user}`.quiet();
}

/** Empties a user's mailbox: every message expunged, and every folder but the standard ones gone. */
export async function empty(user: string) {
  const { doveadm } = await dovecot();
  await $`${doveadm} -c ${conf} expunge -u ${user} mailbox ${'*'} all`.quiet();
  const standard = new Set(['INBOX', 'Drafts', 'Sent', 'Archive', 'Trash', 'Junk']);
  const listed = (await $`${doveadm} -c ${conf} mailbox list -u ${user}`.text()).split('\n');
  // Children before their parents, so each folder is empty of folders when it goes.
  const extra = listed
    .filter((path) => path && !standard.has(path))
    .sort((a, b) => b.length - a.length);
  for (const path of extra)
    await $`${doveadm} -c ${conf} mailbox delete -u ${user} -s ${path}`.quiet().nothrow();
}

/** Gives a folder a new UIDVALIDITY, which tells clients to forget everything they knew of it. */
export async function resetUidValidity(user: string, folder: string) {
  const { doveadm } = await dovecot();
  // One past the current value, because a clock-based one can equal it for a folder made this second.
  const status =
    await $`${doveadm} -c ${conf} mailbox status -u ${user} uidvalidity ${folder}`.text();
  const current = Number(/uidvalidity=(\d+)/.exec(status)?.[1]);
  if (!current) throw new Error(`No UIDVALIDITY for ${user}'s ${folder}: ${status}`);
  await $`${doveadm} -c ${conf} mailbox update -u ${user} --uid-validity ${current + 1} ${folder}`.quiet();
}

/**
 * Fills a user's Inbox from an mbox file, in the file's order, which is far quicker than delivering
 * a large mailbox one message at a time.
 */
export async function importInbox(user: string, mbox: string) {
  const { doveadm } = await dovecot();
  await $`${doveadm} -c ${conf} import -u ${user} -p mail_inbox_path=${mbox} mbox:${dirname(mbox)} ${''} mailbox INBOX all`.quiet();
}

/** Expunges every message in one of a user's folders. */
export async function emptyFolder(user: string, folder: string) {
  const { doveadm } = await dovecot();
  await $`${doveadm} -c ${conf} expunge -u ${user} mailbox ${folder} all`.quiet();
}

/** How many messages a user's folder holds. */
export async function count(user: string, folder: string): Promise<number> {
  const { doveadm } = await dovecot();
  const status = await $`${doveadm} -c ${conf} mailbox status -u ${user} messages ${folder}`.text();
  return Number(/messages=(\d+)/.exec(status)?.[1] ?? 0);
}

/** Where a user's mail lives, for anything kept beside it between runs. */
export function homeOf(user: string): string {
  return join(state, 'mail', user);
}

// Dovecot's configuration

function passwd() {
  const { uid, gid } = userInfo();
  return Object.values(users)
    .map((u) => `${u.email}:{PLAIN}${u.password}:${uid}:${gid}::${join(state, 'mail', u.email)}::`)
    .join('\n');
}

function config(profile: Profile) {
  const { username } = userInfo();
  const group = Bun.spawnSync(['id', '-gn']).stdout.toString().trim();
  const { withhold, roleFlags } = profiles[profile];
  const mailbox = (name: string, use: string) =>
    [
      `  mailbox ${name} {`,
      '    auto = subscribe',
      roleFlags ? `    special_use = ${use}` : '',
      '  }',
    ]
      .filter(Boolean)
      .join('\n');

  return `dovecot_config_version = 2.4.0
dovecot_storage_version = 2.4.0
instance_name = trail-mix-test
base_dir = ${run}
state_dir = ${join(state, 'dovecot')}
log_path = ${join(state, 'dovecot.log')}

default_internal_user = ${username}
default_internal_group = ${group}
default_login_user = ${username}
# Apple silicon reserves more address space than Dovecot's 256M default, and macOS rejects
# Dovecot's value for "unlimited", so the limit is merely huge.
default_vsz_limit = 1T

protocols = imap lmtp
listen = 127.0.0.1, ::1
hostname = localhost

ssl = yes
ssl_server_cert_file = ${join(tls, 'server.crt')}
ssl_server_key_file = ${join(tls, 'server.key')}

passdb passwd-file {
  passwd_file_path = ${join(state, 'users')}
}
userdb passwd-file {
  passwd_file_path = ${join(state, 'users')}
}

# XOAUTH2 and OAUTHBEARER tokens are checked with the stand-in for Microsoft's sign-in.
auth_mechanisms = plain login xoauth2 oauthbearer
oauth2_introspection_mode = get
oauth2_introspection_url = http://127.0.0.1:${ports.identity}/introspect?access_token=
oauth2_force_introspection = yes
oauth2_active_attribute = active
oauth2_active_value = true

mail_driver = maildir
mail_path = ~/Maildir

namespace inbox {
  inbox = yes
  separator = /
${mailbox('Drafts', '\\Drafts')}
${mailbox('Sent', '\\Sent')}
${mailbox('Archive', '\\Archive')}
${mailbox('Trash', '\\Trash')}
${mailbox('Junk', '\\Junk')}
}

${withhold.length ? `imap_capability {\n${withhold.map((cap) => `  "${cap}" = no`).join('\n')}\n}` : ''}

service imap-login {
  chroot =
  inet_listener imap {
    port = ${ports.imap}
  }
  inet_listener imaps {
    port = ${ports.imaps}
  }
}
service lmtp {
  inet_listener lmtp {
    port = ${ports.lmtp}
  }
}
`;
}

// The CA is made once and kept, because clients such as a running workerd read it only when they
// start. The server certificate is reissued on every start, so it never expires.
async function certificates() {
  mkdirSync(tls, { recursive: true });
  if (!existsSync(caFile)) {
    await $`openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -subj "/CN=Trail Mix test CA" -keyout ca.key -out ca.crt`
      .cwd(tls)
      .quiet();
  }
  writeFileSync(
    join(tls, 'server.ext'),
    'subjectAltName=DNS:localhost,IP:127.0.0.1,IP:::1\nextendedKeyUsage=serverAuth\nbasicConstraints=CA:FALSE\n',
  );
  await $`openssl req -new -newkey rsa:2048 -nodes -subj "/CN=localhost" -keyout server.key -out server.csr`
    .cwd(tls)
    .quiet();
  // Apple's verifier, which workerd uses on macOS, refuses server certificates valid for over 398 days.
  await $`openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial -days 397 -extfile server.ext -out server.crt`
    .cwd(tls)
    .quiet();
}

// Readiness. Dovecot greets only once its auth service is up, so a greeting means logins will work.

function imapGreets() {
  return new Promise<boolean>((resolve) => {
    const socket = connect(ports.imap, '127.0.0.1');
    socket.setTimeout(1000, () => socket.destroy());
    socket.once('data', (chunk) => {
      socket.end('a LOGOUT\r\n');
      resolve(chunk.toString().startsWith('* OK'));
    });
    socket.once('error', () => resolve(false));
    socket.once('close', () => resolve(false));
  });
}

async function until(ready: () => boolean | Promise<boolean>, what: string, log: string) {
  const deadline = Date.now() + 15_000;
  while (!(await ready())) {
    if (Date.now() > deadline) throw new Error(`${what} did not come up; see ${log}`);
    await Bun.sleep(100);
  }
}

// Finding Dovecot, or building it on a Mac

type Dovecot = { dovecot: string; doveadm: string };

/** Dovecot 2.4.5 with the upstream fix for TLS logins on macOS, until 2.4.6 reaches Homebrew. */
const patched = {
  version: '2.4.5',
  sources: [
    {
      name: 'dovecot-2.4.5.tar.gz',
      url: 'https://dovecot.org/releases/2.4/dovecot-2.4.5.tar.gz',
      sha256: '868c2686a61b5f8e00a3e4721789b1ab46e6528fd773a5fbed07a6ecba7731e6',
    },
    {
      // Keep the fd passed to post-login open until login reply (dovecot/core 98665ed).
      name: 'tls-handoff.patch',
      url: 'https://github.com/dovecot/core/commit/98665ed44141f5c64078eeaf937c4224403eb9ce.patch',
      sha256: '5cb79ecbd949af15cddc62789f2c781c3619a175882b32bf0cb5959cc5d852da',
    },
    {
      // uoff_t on macOS, the patch Homebrew's own formula applies (dovecot/core#232).
      name: 'uoff.patch',
      url: 'https://github.com/dovecot/core/commit/bbfab4976afdf38a7fa966752de33481f9d2c2e5.patch?full_index=1',
      sha256: 'f5a77eeaf5978b75a6c7d1d9d4b7623679aec047c3dae63516105774ae6c04de',
    },
  ],
  prefix: join(root, 'dovecot-2.4.5-macos'),
};

let building: Promise<void> | undefined;

/** Dovecot's binaries, built first on a Mac that has no Dovecot with the TLS fix. */
async function dovecot(): Promise<Dovecot> {
  const installed = [
    'dovecot',
    '/opt/homebrew/sbin/dovecot',
    '/usr/local/sbin/dovecot',
    '/usr/sbin/dovecot',
  ]
    .map((candidate) =>
      candidate.includes('/') ? (existsSync(candidate) ? candidate : null) : Bun.which(candidate),
    )
    .find((path): path is string => path !== null);
  const version = installed ? versionOf(installed) : null;

  if (process.platform === 'darwin') {
    if (installed && version && atLeast(version, [2, 4, 6])) return binaries(installed);
    // One build at a time: a start that gave up waiting must not begin a second over the first.
    if (!existsSync(join(patched.prefix, 'built'))) {
      await (building ??= buildPatched().finally(() => (building = undefined)));
    }
    return binaries(join(patched.prefix, 'sbin/dovecot'));
  }
  if (installed && version && atLeast(version, [2, 4, 0])) return binaries(installed);
  throw new Error(
    `The test mail server needs Dovecot 2.4 (found ${version ? version.join('.') : 'none'}). ` +
      'On Ubuntu, install dovecot-core, dovecot-imapd and dovecot-lmtpd from repo.dovecot.org, as .github/workflows/ci.yml does.',
  );
}

function binaries(dovecotPath: string): Dovecot {
  const prefix = dirname(dirname(dovecotPath));
  const doveadm = [join(prefix, 'bin/doveadm'), Bun.which('doveadm')].find(
    (path) => path && existsSync(path),
  );
  if (!doveadm) throw new Error(`doveadm not found next to ${dovecotPath}`);
  return { dovecot: dovecotPath, doveadm };
}

function versionOf(binary: string): number[] | null {
  const output = Bun.spawnSync([binary, '--version']).stdout.toString();
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(output);
  return match ? match.slice(1).map(Number) : null;
}

function atLeast(version: number[], minimum: number[]) {
  for (let i = 0; i < minimum.length; i++) {
    const [have, want] = [version[i] ?? 0, minimum[i] ?? 0];
    if (have !== want) return have > want;
  }
  return true;
}

async function buildPatched() {
  const openssl = Bun.spawnSync(['brew', '--prefix', 'openssl@4']).stdout.toString().trim();
  const missing = [
    Bun.spawnSync(['xcode-select', '-p']).exitCode !== 0 &&
      "Xcode's command line tools (xcode-select --install)",
    !(openssl && existsSync(join(openssl, 'include/openssl/evp.h'))) &&
      'OpenSSL 4 (brew install openssl@4)',
    !Bun.which('pkg-config') && 'pkgconf (brew install pkgconf)',
  ].filter(Boolean);
  if (missing.length) {
    throw new Error(
      'The test mail server needs Dovecot 2.4.6 or newer, which Homebrew does not have yet, or a one-time ' +
        `build of ${patched.version} with the upstream fix for TLS logins on macOS. That build needs ` +
        `${missing.join(', ')}.`,
    );
  }

  console.log(
    `Building Dovecot ${patched.version} with the upstream macOS fix, once. This takes a minute or two.`,
  );
  const work = join(root, 'dovecot-build');
  const log = join(root, 'dovecot-build.log');
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  for (const source of patched.sources) {
    const bytes = new Uint8Array(await (await fetch(source.url)).arrayBuffer());
    const sha256 = new Bun.CryptoHasher('sha256').update(bytes).digest('hex');
    if (sha256 !== source.sha256)
      throw new Error(`${source.url} has sha256 ${sha256}, expected ${source.sha256}`);
    writeFileSync(join(work, source.name), bytes);
  }

  const src = join(work, `dovecot-${patched.version}`);
  // Built in place, because its libraries record where they live. A marker says it finished.
  rmSync(patched.prefix, { recursive: true, force: true });
  const env = {
    ...process.env,
    LIBS: '-liconv',
    // OpenSSL 4 changed a few allocator signatures that Dovecot 2.4.5 still passes the old way.
    CFLAGS: '-O2 -Wno-incompatible-function-pointer-types',
    CPPFLAGS: `-I${openssl}/include`,
    LDFLAGS: `-L${openssl}/lib`,
    PKG_CONFIG_PATH: `${openssl}/lib/pkgconfig`,
  };
  const without = [
    'lua',
    'ldap',
    'sqlite',
    'pam',
    'icu',
    'stemmer',
    'textcat',
    'lz4',
    'zstd',
    'bzlib',
    'lzma',
  ];
  const steps = [
    `tar xzf ${patched.sources[0]!.name}`,
    `cd ${src} && patch -p1 < ../tls-handoff.patch && patch -p1 < ../uoff.patch`,
    // Regenerated on macOS, as Homebrew does, because only Linux builds imap-hibernate's inotify.
    `cd ${src} && rm -f src/config/all-settings.c`,
    `cd ${src} && ./configure --prefix=${patched.prefix} --with-ssl=openssl ${without.map((w) => `--without-${w}`).join(' ')}`,
    `cd ${src} && make -j${navigator.hardwareConcurrency}`,
    `cd ${src} && make install`,
  ];
  const output = openSync(log, 'w');
  for (const step of steps) {
    const exitCode = await Bun.spawn(['sh', '-c', step], {
      cwd: work,
      env,
      stdio: ['ignore', output, output],
    }).exited;
    if (exitCode !== 0) throw new Error(`Building Dovecot failed at "${step}"; see ${log}`);
  }
  writeFileSync(join(patched.prefix, 'built'), '');
  rmSync(work, { recursive: true, force: true });
}

// The Bun half: submission and the stand-in for Microsoft's sign-in, run detached by `start`

/**
 * Pauses a user's sending, or resumes it, as a host does when an account is over its sending limit.
 * While paused, submission refuses the user's mail with a 554.
 */
export function pauseSending(user: string, paused: boolean) {
  mkdirSync(join(state, 'paused'), { recursive: true });
  if (paused) writeFileSync(pausedFile(user), '');
  else rmSync(pausedFile(user), { force: true });
}

const pausedFile = (user: string) => join(state, 'paused', user.toLowerCase());

/**
 * Turns a user's SMTP sign-in off, or on again, as Outlook does for an account whose SMTP AUTH is
 * off: IMAP still takes the password, and submission refuses it with a 535.
 */
export function refuseSubmissionSignIn(user: string, refused: boolean) {
  mkdirSync(join(state, 'no-submission'), { recursive: true });
  if (refused) writeFileSync(noSubmissionFile(user), '');
  else rmSync(noSubmissionFile(user), { force: true });
}

const noSubmissionFile = (user: string) => join(state, 'no-submission', user.toLowerCase());

/**
 * When submission files its own copy in Sent of what a user sends: `later`, a moment after it
 * replies, as Zoho and Outlook do; `at-once`, before it replies; `held`, only once `settled` lets
 * it, as a host running late would; or `never`, as Zoho does once its copies are turned off.
 */
export type Filing = 'later' | 'at-once' | 'held' | 'never';

/**
 * Chooses when submission files a user's copies in Sent, from the next message on. Without a
 * choice, the profile decides: `later` where the host files its own, and `never` elsewhere.
 */
export function fileSentCopies(user: string, filing: Filing | undefined) {
  mkdirSync(join(state, 'filing'), { recursive: true });
  if (filing) writeFileSync(filingFile(user), filing);
  else rmSync(filingFile(user), { force: true });
}

const filingFile = (user: string) => join(state, 'filing', user.toLowerCase());

/** How long a host that files its own copy in Sent `later` takes to file it. */
const FILING_DELAY_MS = 250;

/**
 * Waits until the host has filed every copy in Sent it owes, letting it file those it was holding.
 */
export async function settled() {
  const deadline = Date.now() + 10_000;
  await fetch(`http://127.0.0.1:${ports.identity}/filing`, { method: 'POST' });
  for (;;) {
    const response = await fetch(`http://127.0.0.1:${ports.identity}/filing`);
    // Read as unknown, since the browser's Response, which a browser test reaching this sees, takes
    // no type for its body.
    const body: unknown = await response.json();
    const { filing } = body as { filing: number };
    if (filing === 0) return;
    if (Date.now() > deadline) throw new Error('The host never filed its copy in Sent.');
    await Bun.sleep(50);
  }
}

/** The header that has submission take a message and then drop the connection without a reply. */
export const DROP_AFTER_DATA_HEADER = 'X-Trail-Mix-Test: drop-after-data';
const DROP_AFTER_DATA = new RegExp(`^${DROP_AFTER_DATA_HEADER}\\r?$`, 'im');
type Dropping = { id: string; close(): void };

async function serve() {
  writeFileSync(join(state, 'serve.pid'), String(process.pid));
  const { filesSent } = profiles[readFileSync(join(state, 'profile'), 'utf8').trim() as Profile];
  const { doveadm } = await dovecot();
  const filingOf = (user: string): Filing =>
    existsSync(filingFile(user))
      ? (readFileSync(filingFile(user), 'utf8') as Filing)
      : filesSent
        ? 'later'
        : 'never';
  /** Files a copy in a user's Sent, read, as a host files what its member sent. */
  const save = async (user: string, raw: Buffer) => {
    await Bun.spawn([doveadm, '-c', conf, 'save', '-u', user, '-m', 'Sent'], { stdin: raw }).exited;
    const seen = ['flags', 'add', '-u', user, '\\Seen', 'mailbox', 'Sent', 'unseen'];
    await Bun.spawn([doveadm, '-c', conf, ...seen]).exited;
  };
  /** How many copies the host owes Sent: accepted and not yet filed. */
  let filing = 0;
  /** Owes a copy, which the returned function files. */
  const owe = (user: string, raw: Buffer) => {
    filing++;
    return () => void save(user, raw).finally(() => filing--);
  };
  /** The copies it holds until a test lets it file them. */
  const held: (() => void)[] = [];
  const { SMTPServer } = await import('smtp-server');
  const nodemailer = (await import('nodemailer')).default;
  const lmtp = nodemailer.createTransport({
    host: '127.0.0.1',
    port: ports.lmtp,
    lmtp: true,
    ignoreTLS: true,
  });
  const key = readFileSync(join(tls, 'server.key'));
  const cert = readFileSync(join(tls, 'server.crt'));
  const signIn = signInStandIn();

  const reject = (code: number, message: string) =>
    Object.assign(new Error(message), { responseCode: code });
  const authenticate = (auth: SMTPServerAuthentication) =>
    auth.method === 'XOAUTH2'
      ? signIn.userOf(auth.accessToken ?? '') === auth.username
      : Object.values(users).some((u) => u.email === auth.username && u.password === auth.password);

  // Submission on implicit TLS and on STARTTLS, with AUTH refused until TLS, as a real host does it.
  const listeners = [ports.submissions, ports.submission].flatMap((port) =>
    ['127.0.0.1', '::1'].map((address) => ({ port, address, secure: port === ports.submissions })),
  );
  let listening = 0;
  const servers = listeners.map(({ port, address, secure }) => {
    const server = new SMTPServer({
      secure,
      key,
      cert,
      name: 'localhost',
      banner: 'Trail Mix test submission',
      authMethods: ['PLAIN', 'LOGIN', 'XOAUTH2'],
      onAuth(auth, _session, callback) {
        if (!authenticate(auth)) return callback(reject(535, 'Invalid credentials'));
        if (existsSync(noSubmissionFile(auth.username ?? ''))) {
          return callback(
            reject(535, '5.7.139 Authentication unsuccessful, SMTP AUTH is disabled'),
          );
        }
        callback(null, { user: auth.username });
      },
      onMailFrom(address, session, callback) {
        if (address.address.toLowerCase() !== String(session.user).toLowerCase()) {
          return callback(reject(553, 'Sender must be the signed-in user'));
        }
        if (existsSync(pausedFile(address.address))) {
          return callback(reject(554, '5.7.1 Sending is paused for this account'));
        }
        callback();
      },
      // Only the test domain is delivered, so this server can never send mail anywhere else.
      onRcptTo(address, _session, callback) {
        if (!address.address.toLowerCase().endsWith(`@${domain}`)) {
          return callback(reject(550, `Only @${domain} is delivered here`));
        }
        callback();
      },
      onData(stream, session, callback) {
        const chunks: Buffer[] = [];
        stream.on('data', (chunk: Buffer) => chunks.push(chunk));
        stream.on('end', () => {
          const from = session.envelope.mailFrom ? session.envelope.mailFrom.address : '';
          const to = session.envelope.rcptTo.map((r) => r.address);
          const raw = Buffer.concat(chunks);
          lmtp
            .sendMail({ envelope: { from, to }, raw })
            .then(async () => {
              const when = filingOf(from);
              if (when === 'at-once') await save(from, raw);
              if (when === 'held') held.push(owe(from, raw));
              // Zoho and Outlook file their copy a moment after they accept, not at once.
              if (when === 'later') setTimeout(owe(from, raw), FILING_DELAY_MS);
            })
            .then(
              () => {
                // A test can have the connection drop after the message was taken, before the reply.
                if (!DROP_AFTER_DATA.test(raw.toString('latin1'))) return callback();
                for (const connection of (server as unknown as { connections: Set<Dropping> })
                  .connections) {
                  if (connection.id === session.id) connection.close();
                }
              },
              (error: Error) => callback(error),
            );
        });
      },
    });
    // A client that drops mid-handshake is the client's problem, not the server's.
    server.on('error', (error) => console.error(`submission ${port}: ${error.message}`));
    server.listen(port, address, () => {
      if (++listening === listeners.length) writeFileSync(join(state, 'serve.ready'), '');
    });
    return server;
  });

  const http = Bun.serve({
    hostname: '127.0.0.1',
    port: ports.identity,
    fetch: (request) => {
      if (new URL(request.url).pathname !== '/filing') return signIn.fetch(request);
      // A POST lets the host file what it was holding.
      if (request.method === 'POST') for (const file of held.splice(0)) file();
      return Response.json({ filing });
    },
  });
  process.on('SIGTERM', () => {
    for (const server of servers) server.close();
    void http.stop(true);
    process.exit(0);
  });
}

/** The stand-in for Microsoft's sign-in, at the address the test mail server serves it on. */
export function signInStandIn() {
  return standIn(`http://127.0.0.1:${ports.identity}`);
}

// The command line

if (import.meta.main) {
  const [command = 'status', ...args] = process.argv.slice(2);
  switch (command) {
    case 'start': {
      const flag = args.indexOf('--profile');
      const profile = (flag >= 0 ? args[flag + 1] : 'full') as Profile;
      if (!(profile in profiles))
        throw new Error(`Unknown profile ${profile}. Choose full, zoho, outlook or plain.`);
      await start(profile);
      console.log(
        `The test mail server is up with the ${profile} profile. Clients trust ${caFile}.`,
      );
      break;
    }
    case 'prepare':
      // `bun run test:mail` prepares first, so no test waits on a build.
      await dovecot();
      break;
    case 'serve':
      await serve();
      break;
    case 'stop':
      await stop();
      break;
    case 'status': {
      const profile = running();
      console.log(profile ? `running, ${profile} profile` : 'stopped');
      break;
    }
    case 'clean':
      // Keeps the macOS Dovecot build, which takes minutes to make again.
      await stop();
      rmSync(state, { recursive: true, force: true });
      break;
    default:
      throw new Error(`Unknown command ${command}.`);
  }
}
