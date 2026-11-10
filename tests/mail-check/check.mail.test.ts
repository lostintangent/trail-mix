// The check command, end to end: a Durable Object on local workerd against the test mail server,
// signing in with a password piped in, and with the device-code flow against the stand-in for
// Microsoft's sign-in.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { join } from 'node:path';
import { ports, start, stop, users } from '../mail-server/server.ts';

setDefaultTimeout(180_000);
beforeAll(() => start('full'));
afterAll(stop);

const check = (...args: string[]) =>
  Bun.spawn(['bun', join(import.meta.dir, 'check.ts'), ...args], {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });

describe('the check command', () => {
  test('passes every check with a password from a pipe, and never prints it', async () => {
    const { alice } = users;
    const run = check('--preset', 'test', '--user', alice.email, '--watch-minutes', '0.25');
    void run.stdin.write(`${alice.password}\n`);
    void run.stdin.end();
    const [out, err, exit] = await Promise.all([
      new Response(run.stdout).text(),
      new Response(run.stderr).text(),
      run.exited,
    ]);

    const lines = out.trim().split('\n').slice(1);
    expect(lines.map((line) => line.slice(0, 4))).toEqual(['PASS', 'PASS', 'PASS', 'PASS']);
    expect(out).toContain('send to self over 3465 (implicit TLS)');
    expect(out).toContain('send to self over 3587 (STARTTLS)');
    expect(out).toContain('watch INBOX for 15s, then see new mail');
    expect(out + err).not.toContain(alice.password);
    expect(exit).toBe(0);
  });

  test('passes every check after signing in with a device code, as Outlook does', async () => {
    const { bob } = users;
    const run = check('--preset', 'test-outlook', '--user', bob.email);
    // Play the person: read the code from the prompt and sign in with it.
    let err = '';
    const decoder = new TextDecoder();
    for await (const chunk of run.stderr) {
      err += decoder.decode(chunk);
      const userCode = /enter the code (\w+)/.exec(err)?.[1];
      if (userCode) {
        await fetch(`http://127.0.0.1:${ports.identity}/devicelogin`, {
          method: 'POST',
          body: new URLSearchParams({ user_code: userCode, login_hint: bob.email }),
        });
        break;
      }
    }
    const [out, exit] = await Promise.all([new Response(run.stdout).text(), run.exited]);

    const lines = out.trim().split('\n').slice(1);
    expect(lines.map((line) => line.slice(0, 4))).toEqual(['PASS', 'PASS']);
    expect(out).toContain('send to self over 3587 (STARTTLS)');
    expect(exit).toBe(0);
  });

  test('fails, and says why, when the password is wrong', async () => {
    const run = check('--preset', 'test', '--user', users.alice.email);
    void run.stdin.write('not-the-password\n');
    void run.stdin.end();
    const [out, exit] = await Promise.all([new Response(run.stdout).text(), run.exited]);

    expect(out).toMatch(/^FAIL .*list folders/m);
    expect(out).toMatch(/^FAIL .*535/m);
    expect(out).not.toContain('not-the-password');
    expect(exit).toBe(1);
  });
});
