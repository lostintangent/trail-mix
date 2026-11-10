// Other mail clients, run natively against the test mail server, to show that what Trail Mix writes
// reads right elsewhere: Roundcube, the webmail many people host for themselves, and mutt, the
// terminal client. A Mac has neither, and installing them is its owner's call, so there a test that
// needs one skips and says why. CI installs both and sets MAIL_CLIENTS=required, so a client
// missing there fails the run instead.
import { join } from 'node:path';

/** Where a client downloaded for the tests is kept between runs, beside the test mail server. */
export const clientsDir = join(import.meta.dir, '../../.mail-server/clients');

/** Why tests needing these programs can't run here, or nothing when they can. */
export function missing(...programs: string[]): string | undefined {
  const absent = programs.filter((program) => Bun.which(program) === null);
  if (absent.length === 0) return undefined;
  const reason = `they need ${absent.join(' and ')}, which this machine doesn't have`;
  if (process.env.MAIL_CLIENTS === 'required') {
    throw new Error(`The other mail clients' tests can't run: ${reason}.`);
  }
  console.warn(
    `Skipping the other mail clients' tests: ${reason}. On a Mac: brew install mutt php`,
  );
  return reason;
}
