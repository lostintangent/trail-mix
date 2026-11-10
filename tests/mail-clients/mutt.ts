// mutt, signed in as one user of the test mail server. It draws a screen, so it runs in a
// pseudo-terminal, and a test hands it the keys a person would press. What it shows comes back
// through the files it writes, so nothing reads the screen, which is kept only to explain a failure.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { caFile, ports } from '../mail-server/server.ts';

export type MuttUser = { email: string; password: string };

/**
 * Runs mutt on `user`'s Inbox, threaded by References and In-Reply-To alone, presses `keys`, which
 * must end by quitting, and resolves with the directory it ran in, where it wrote its files.
 */
export async function mutt(user: MuttUser, keys: string, timeout = 30_000): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'trailmix-mutt-'));
  const quoted = (value: string) => `"${value.replace(/[\\"$`]/g, '\\$&')}"`;
  writeFileSync(
    join(dir, 'muttrc'),
    [
      `set folder=${quoted(`imaps://localhost:${ports.imaps}/`)}`,
      'set spoolfile="+INBOX"',
      `set imap_user=${quoted(user.email)}`,
      `set imap_pass=${quoted(user.password)}`,
      'set ssl_force_tls=yes',
      // GnuTLS builds, such as Ubuntu's, trust a CA file. OpenSSL builds, such as Homebrew's, trust
      // the certificates in certificate_file.
      gnutls()
        ? `set ssl_ca_certificates_file=${quoted(caFile)}`
        : `set certificate_file=${quoted(caFile)}`,
      // Threads by the headers alone, never by a shared subject, so threading is the headers' doing.
      'set sort=threads',
      'set strict_threads=yes',
      // A piped message is what mutt shows: its headers weeded and its body decoded.
      'set pipe_decode=yes',
      'set pipe_split=yes',
      'set wait_key=no',
      'set quit=yes',
      'set confirmappend=no',
      'set confirmcreate=no',
      'set beep=no',
      'set charset="utf-8"',
      `push ${quoted(keys)}`,
    ].join('\n'),
  );
  const screen: string[] = [];
  const process_ = Bun.spawn(['mutt', '-n', '-F', join(dir, 'muttrc')], {
    cwd: dir,
    env: { ...process.env, HOME: dir, TERM: 'xterm', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' },
    terminal: { cols: 160, rows: 48, data: (_terminal, data) => screen.push(String(data)) },
  });
  const finished = await Promise.race([
    process_.exited.then((code) => code === 0),
    Bun.sleep(timeout).then(() => false),
  ]);
  if (!finished) {
    process_.kill();
    const shown = Bun.stripANSI(screen.join(''));
    throw new Error(`mutt didn't finish. Its screen last read:\n${shown.slice(-4000)}`);
  }
  return dir;
}

/** Whether this mutt does TLS with GnuTLS rather than OpenSSL. */
const gnutls = () => Bun.spawnSync(['mutt', '-v']).stdout.toString().includes('+USE_SSL_GNUTLS');
