// Roundcube, the webmail many people host for themselves, served by PHP's own server against the
// test mail server. The release is pinned by its checksum and kept between runs, and every start
// begins with a new database, so nothing one run saw carries into the next.
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { $ } from 'bun';
import { caFile, ports } from '../mail-server/server.ts';
import { clientsDir } from './clients.ts';

const RELEASE = {
  version: '1.7.6',
  url: 'https://github.com/roundcube/roundcubemail/releases/download/1.7.6/roundcubemail-1.7.6-complete.tar.gz',
  sha256: '0168085bf0bfeeb5d4eca3b9730effbe610dbdb380a68567d292fec51f09db36',
};

export type Roundcube = { url: string; stop(): Promise<void> };

/** Roundcube on 127.0.0.1:`port`, reading the test mail server's IMAP, threads expanded. */
export async function roundcube(port: number): Promise<Roundcube> {
  const home = await installed();
  const state = join(clientsDir, `roundcube-${port}`);
  rmSync(state, { recursive: true, force: true });
  for (const dir of ['logs', 'temp']) mkdirSync(join(state, dir), { recursive: true });
  // Roundcube creates its SQLite database's tables when it first opens it.
  writeFileSync(join(home, 'config', 'config.inc.php'), configFor(state));

  const server = Bun.spawn(['php', '-S', `127.0.0.1:${port}`, '-t', join(home, 'public_html')], {
    cwd: home,
    stdout: 'ignore',
    stderr: 'ignore',
  });
  const url = `http://127.0.0.1:${port}`;
  for (const deadline = Date.now() + 10_000; ;) {
    const answered = await fetch(url).then(
      (response) => response.ok,
      () => false,
    );
    if (answered) break;
    if (Date.now() > deadline) {
      server.kill();
      throw new Error(`Roundcube didn't answer on ${url}.`);
    }
    await Bun.sleep(100);
  }
  return {
    url,
    async stop() {
      server.kill();
      await server.exited;
    },
  };
}

/** The pinned release, downloaded once and checked against its checksum. */
async function installed(): Promise<string> {
  const home = join(clientsDir, `roundcubemail-${RELEASE.version}`);
  if (existsSync(join(home, 'public_html', 'index.php'))) return home;
  mkdirSync(clientsDir, { recursive: true });
  const bytes = new Uint8Array(await (await fetch(RELEASE.url)).arrayBuffer());
  const sha256 = new Bun.CryptoHasher('sha256').update(bytes).digest('hex');
  if (sha256 !== RELEASE.sha256) {
    throw new Error(`${RELEASE.url} has sha256 ${sha256}, expected ${RELEASE.sha256}.`);
  }
  const archive = join(clientsDir, 'roundcube.tar.gz');
  writeFileSync(archive, bytes);
  await $`tar xzf ${archive} -C ${clientsDir}`.quiet();
  rmSync(archive);
  return home;
}

function configFor(state: string): string {
  const php = (value: string) => `'${value.replace(/[\\']/g, '\\$&')}'`;
  const settings: [string, string][] = [
    ['db_dsnw', php(`sqlite:///${join(state, 'roundcube.db')}?mode=0646`)],
    ['imap_host', php(`ssl://localhost:${ports.imaps}`)],
    [
      'imap_conn_options',
      `['ssl' => ['verify_peer' => true, 'verify_peer_name' => true, 'cafile' => ${php(caFile)}]]`,
    ],
    ['smtp_host', php('')],
    ['des_key', php('trailmix-test-key-24-chr')],
    ['plugins', '[]'],
    ['temp_dir', php(`${join(state, 'temp')}/`)],
    ['log_dir', php(`${join(state, 'logs')}/`)],
    ['enable_installer', 'false'],
    ['ip_check', 'false'],
    ['default_list_mode', php('threads')],
    ['autoexpand_threads', '1'],
    ['prefer_html', 'true'],
    ['messages_cache', 'false'],
  ];
  return `<?php\n$config = [];\n${settings.map(([key, value]) => `$config[${php(key)}] = ${value};`).join('\n')}\n`;
}
