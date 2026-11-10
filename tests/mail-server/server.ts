// The test mail server. Dovecot 2.4 serves IMAP and takes local delivery over LMTP. One Bun
// process serves submission on implicit TLS and STARTTLS, delivering into Dovecot, and stands in
// for Microsoft's sign-in so the OAuth path can be exercised. Everything binds to loopback, nothing
// runs as root, and nothing can reach another mail host.
//
//   bun tests/mail-server/server.ts start [--profile full|zoho|outlook]
//   bun tests/mail-server/server.ts stop | status | clean
//   bun tests/mail-server/server.ts kick <user>
//   bun tests/mail-server/server.ts reset-uidvalidity <user> <folder>

import { $ } from 'bun';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir, userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import type { SMTPServerAuthentication } from 'smtp-server';

export const domain = 'trailmix.test';

export const users = {
  alice: { email: `alice@${domain}`, password: 'alice-test-password' },
  bob: { email: `bob@${domain}`, password: 'bob-test-password' },
} as const;

export const ports = {
  imap: 3143, // STARTTLS
  imaps: 3993, // implicit TLS
  submission: 3587, // STARTTLS
  submissions: 3465, // implicit TLS
  lmtp: 3024, // local delivery into Dovecot
  identity: 3080, // the stand-in for Microsoft's sign-in
} as const;

/** The stand-in for login.microsoftonline.com, for the device-code flow and XOAUTH2. */
export const identity = { authority: `http://127.0.0.1:${ports.identity}/consumers` } as const;

/**
 * Capabilities each profile withholds, so code cannot lean on what Zoho and Outlook lack. Zoho also
 * marks no folder with a role, so roles must be found some other way.
 */
export const profiles = {
  full: { withhold: [], roleFlags: true },
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
  },
  outlook: { withhold: ['CONDSTORE', 'QRESYNC'], roleFlags: true },
} as const;
export type Profile = keyof typeof profiles;

const root = join(import.meta.dir, '../../.mail-server');
const state = join(root, 'state');
const tls = join(state, 'tls');
const conf = join(state, 'dovecot.conf');
// Unix socket paths are capped near 104 bytes, so Dovecot's runtime directory stays short.
const run = join(
  tmpdir().startsWith('/var/') ? '/tmp' : tmpdir(),
  `trail-mix-mail-${userInfo().uid}`,
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
  const log = openSync(join(state, 'serve.log'), 'a');
  const child = spawn(process.execPath, [import.meta.path, 'serve'], {
    detached: true,
    stdio: ['ignore', log, log],
  });
  writeFileSync(join(state, 'serve.pid'), String(child.pid));
  child.unref();

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
    if (!existsSync(join(patched.prefix, 'built'))) await buildPatched();
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

async function serve() {
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
        callback(null, { user: auth.username });
      },
      onMailFrom(address, session, callback) {
        if (address.address.toLowerCase() !== String(session.user).toLowerCase()) {
          return callback(reject(553, 'Sender must be the signed-in user'));
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
          lmtp.sendMail({ envelope: { from, to }, raw: Buffer.concat(chunks) }).then(
            () => callback(),
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

  const http = Bun.serve({ hostname: '127.0.0.1', port: ports.identity, fetch: signIn.fetch });
  process.on('SIGTERM', () => {
    for (const server of servers) server.close();
    void http.stop(true);
    process.exit(0);
  });
}

/**
 * The endpoints of Microsoft's device-code sign-in, as login.microsoftonline.com answers them, plus
 * `POST /devicelogin`, where a test plays the person who signs in, and the token introspection
 * Dovecot asks. Every code and token lives in this process's memory.
 */
export function signInStandIn() {
  type Grant = {
    clientId: string;
    scope: string;
    userCode: string;
    expiresAt: number;
    user?: string;
    declined?: boolean;
  };
  const grants = new Map<string, Grant>();
  const tokens = new Map<string, string>();
  const random = () => crypto.randomUUID().replaceAll('-', '');
  const error = (code: string, status = 400) =>
    Response.json({ error: code, error_description: code }, { status });

  async function fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const form =
      request.method === 'POST' ? new URLSearchParams(await request.text()) : url.searchParams;

    if (request.method === 'POST' && /^\/[^/]+\/oauth2\/v2\.0\/devicecode$/.test(url.pathname)) {
      const clientId = form.get('client_id');
      if (!clientId) return error('invalid_request');
      const userCode = random().slice(0, 8).toUpperCase();
      const deviceCode = random();
      grants.set(deviceCode, {
        clientId,
        scope: form.get('scope') ?? '',
        userCode,
        expiresAt: Date.now() + 900_000,
      });
      const verificationUri = `http://127.0.0.1:${ports.identity}/devicelogin`;
      return Response.json({
        device_code: deviceCode,
        user_code: userCode,
        verification_uri: verificationUri,
        expires_in: 900,
        interval: 1,
        message: `To sign in, use a web browser to open the page ${verificationUri} and enter the code ${userCode} to authenticate.`,
      });
    }

    if (request.method === 'POST' && /^\/[^/]+\/oauth2\/v2\.0\/token$/.test(url.pathname)) {
      if (form.get('grant_type') !== 'urn:ietf:params:oauth:grant-type:device_code')
        return error('unsupported_grant_type');
      const grant = grants.get(form.get('device_code') ?? '');
      if (!grant || grant.clientId !== form.get('client_id')) return error('bad_verification_code');
      if (Date.now() > grant.expiresAt) return error('expired_token');
      if (grant.declined) return error('authorization_declined');
      if (!grant.user) return error('authorization_pending');
      grants.delete(form.get('device_code') ?? '');
      const accessToken = random();
      tokens.set(accessToken, grant.user);
      return Response.json({
        token_type: 'Bearer',
        scope: grant.scope,
        expires_in: 3600,
        access_token: accessToken,
        refresh_token: random(),
      });
    }

    if (request.method === 'POST' && url.pathname === '/devicelogin') {
      const grant = [...grants.values()].find((g) => g.userCode === form.get('user_code'));
      if (!grant) return error('invalid_user_code', 404);
      if (form.get('decline')) grant.declined = true;
      else grant.user = form.get('login_hint') ?? '';
      return new Response(null, { status: 204 });
    }

    if (url.pathname === '/introspect') {
      const user = tokens.get(form.get('access_token') ?? '');
      return Response.json(user ? { active: 'true', email: user } : { active: 'false' });
    }

    return new Response(null, { status: 404 });
  }

  return { fetch, userOf: (token: string) => tokens.get(token) };
}

// The command line

if (import.meta.main) {
  const [command = 'status', ...args] = process.argv.slice(2);
  switch (command) {
    case 'start': {
      const flag = args.indexOf('--profile');
      const profile = (flag >= 0 ? args[flag + 1] : 'full') as Profile;
      if (!(profile in profiles))
        throw new Error(`Unknown profile ${profile}. Choose full, zoho or outlook.`);
      await start(profile);
      console.log(
        `The test mail server is up with the ${profile} profile. Clients trust ${caFile}.`,
      );
      break;
    }
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
    case 'kick':
      await kick(args[0] ?? '');
      break;
    case 'reset-uidvalidity':
      await resetUidValidity(args[0] ?? '', args[1] ?? '');
      break;
    default:
      throw new Error(`Unknown command ${command}.`);
  }
}
