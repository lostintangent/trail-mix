import { COMMANDS, receivedCall } from '../client/contract.ts';
import { Mailroom, type MailroomEnv } from './mailroom.ts';

/**
 * The Mailroom on workerd, for tests. A path's first segment names the member, standing in for the
 * Worker's sign-in, which `src/server` proves. `POST /<member>/call` runs a query or command,
 * `/<member>/updates` opens the hint socket, and the subclass adds what a test needs to look inside.
 */
export class TestMailroom extends Mailroom {
  private readonly wakes: Wake[] = [];

  /** Records each wake that landed anything, with each account's status and indexed mail after it. */
  protected override async wake(): Promise<number> {
    const steps = await super.wake();
    if (steps === 0) return steps;
    const accounts = await this.accounts();
    this.wakes.push({
      steps,
      accounts: accounts.map(({ id, name, status }) => ({
        name,
        status,
        messages: this.sql.all<{ n: number }>(
          `SELECT COUNT(*) AS n FROM messages WHERE account = ?`,
          id,
        )[0]!.n,
      })),
    });
    return steps;
  }

  wakeLog(): Promise<Wake[]> {
    return Promise.resolve(this.wakes);
  }

  /** Ends this instance, as a deploy or an eviction would. The next request starts a new one. */
  restart(): Promise<void> {
    this.ctx.abort('A test restarted the Mailroom.');
    return Promise.resolve();
  }

  private restartOnAcceptance = false;

  /**
   * Ends this instance the next time a host accepts a message, before the Outbox can record it:
   * the one instant a restart leaves a send's fate unknown.
   */
  restartWhenAccepted(): Promise<void> {
    this.restartOnAcceptance = true;
    return Promise.resolve();
  }

  protected override accepted(): void {
    if (this.restartOnAcceptance) this.ctx.abort('A test restarted the Mailroom mid-send.');
  }

  /**
   * Has an account's provider leave Sent to the host, as Outlook's preset does, and restarts so the
   * provider is made again. Setup can't say so for a host it names itself.
   */
  async hostFilesSent(account: string): Promise<void> {
    this.sql.run(
      `UPDATE accounts SET connection = json_set(connection, '$.filesSent', json('true')) WHERE id = ?`,
      account,
    );
    // A restart drops writes not yet on disk.
    await this.ctx.storage.sync();
    await this.restart();
  }

  /** Erases the envelope index and the body cache, which sync rebuilds from the servers. */
  async eraseIndex(): Promise<void> {
    for (const { id } of await this.accounts()) this.store.forget(id);
    await this.forgetBodies(`${this.member}/`);
  }

  /** Every row Trail Mix stored for this member, blobs as Latin-1 text, and every cached body. */
  async stored(): Promise<{ tables: Record<string, unknown[]>; bodies: string[] }> {
    const tables: Record<string, unknown[]> = {};
    const names = this.sql.all<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'
         AND name NOT LIKE '\\_\\_miniflare%' ESCAPE '\\'`,
    );
    for (const { name } of names) {
      tables[name] = this.sql
        .all<Record<string, unknown>>(`SELECT * FROM "${name}"`)
        .map((row) =>
          Object.fromEntries(
            Object.entries(row).map(([column, value]) => [
              column,
              value instanceof ArrayBuffer ? new TextDecoder('latin1').decode(value) : value,
            ]),
          ),
        );
    }
    const listed = await this.env.BODIES.list({ prefix: `${this.member}/` });
    return { tables, bodies: listed.objects.map((object) => object.key) };
  }
}

export type Wake = {
  steps: number;
  accounts: { name: string; status: string; messages: number }[];
};

type Env = MailroomEnv & { MAILROOM: DurableObjectNamespace<TestMailroom> };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const [, member, action] = url.pathname.split('/');
    if (!member) return new Response('The Mailroom, for tests.');
    const mailroom = env.MAILROOM.get(env.MAILROOM.idFromName(member));
    if (action === 'updates') {
      return mailroom.fetch(new Request(url, { headers: { Upgrade: 'websocket' } }));
    }
    if (action === 'call' && request.method === 'POST') {
      // A call carrying files crosses as it does from a browser, its files read into bytes.
      const { name, args } = request.headers.get('Content-Type')?.startsWith('multipart/form-data')
        ? await receivedCall(COMMANDS, await request.formData())
        : await request.json<{ name: string; args: unknown[] }>();
      const methods = mailroom as unknown as Record<
        string,
        (...args: unknown[]) => Promise<unknown>
      >;
      try {
        return Response.json({ value: (await methods[name]!(...args)) ?? null });
      } catch (error) {
        return Response.json({ error: error instanceof Error ? error.message : String(error) });
      }
    }
    return new Response('Not found', { status: 404 });
  },
};
