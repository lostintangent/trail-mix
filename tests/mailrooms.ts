// The Mailroom on the local Workers runtime, as tests reach it: a worker with its own storage, and
// each member's Mailroom called as a browser calls it.
import { join } from 'node:path';
import type {
  ConversationSummary,
  Folder,
  Hint,
  Message,
  View,
} from '../src/features/mail/core/index.ts';
import { sendable, type Page } from '../src/features/mailroom/client/contract.ts';
import { caFile } from './mail-server/server.ts';
import { startWorker, type LocalWorker } from './workerd.ts';

/** The test worker, with its own storage, and with `vars` added to its environment. */
export function mailrooms(vars: Record<string, string> = {}) {
  return startWorker(
    {
      name: 'trail-mix-mailroom-test',
      main: join(import.meta.dir, '../src/features/mailroom/server/test-worker.ts'),
      durable_objects: { bindings: [{ name: 'MAILROOM', class_name: 'TestMailroom' }] },
      migrations: [{ tag: 'v1', new_sqlite_classes: ['TestMailroom'] }],
      r2_buckets: [{ binding: 'BODIES', bucket_name: 'bodies' }],
      vars: { CREDENTIALS_KEY: 'a-test-key-that-is-at-least-32-characters', ...vars },
    },
    { env: { NODE_EXTRA_CA_CERTS: caFile } },
  );
}

/** A member's Mailroom, reached as the test worker names it. */
export function member(name: string, worker: () => LocalWorker) {
  const call = async <T = unknown>(method: string, ...args: unknown[]): Promise<T> => {
    // As a browser sends it: a call carrying files goes as form data.
    const sent = sendable({ name: method, args });
    const response = await fetch(`${worker().url}/${name}/call`, {
      method: 'POST',
      body: sent instanceof FormData ? sent : JSON.stringify(sent),
    });
    const result = await response.json<{ value?: T; error?: string }>();
    if (result.error !== undefined) throw new Error(result.error);
    return result.value as T;
  };

  /** Every row of a view, following its pages. */
  async function page(view: View): Promise<ConversationSummary[]> {
    const rows: ConversationSummary[] = [];
    for (let after: string | undefined; ;) {
      const next: Page = await call<Page>('conversations', view, after);
      rows.push(...next.items);
      if (!next.next) return rows;
      after = next.next;
    }
  }

  return {
    call,
    page,

    /** What a browser would show: folders, the unified Inbox, and each folder's conversations. */
    async snapshot() {
      const folders = await call<Folder[]>('folders');
      const inbox = await page({ in: 'inbox' });
      const lists = await Promise.all(
        folders.map((folder) =>
          page({ in: 'folder', folder: { account: folder.account, path: folder.path } }),
        ),
      );
      const threads = await Promise.all(
        inbox.map((row) => call<Message[]>('conversation', row.id)),
      );
      return { folders, inbox, lists, threads };
    },

    async until(done: () => Promise<boolean>, ms = 30_000) {
      const deadline = Date.now() + ms;
      while (!(await done())) {
        if (Date.now() > deadline) throw new Error('Timed out');
        await Bun.sleep(100);
      }
    },

    /** An open browser: its hint socket, and every hint it has heard. */
    device() {
      const socket = new WebSocket(`${worker().url.replace('http', 'ws')}/${name}/updates`);
      const hints: Hint[] = [];
      const waiting = new Set<() => void>();
      socket.addEventListener('message', (event) => {
        hints.push(JSON.parse(String(event.data)) as Hint);
        for (const wake of waiting) wake();
      });
      return {
        hints,
        opened: new Promise((resolve, reject) => {
          socket.addEventListener('open', resolve);
          socket.addEventListener('error', reject);
        }),
        /** Resolves when a hint from now on matches. */
        next(matches: (hint: Hint) => boolean, ms = 10_000) {
          const from = hints.length;
          return new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('No such hint arrived')), ms);
            const wake = () => {
              if (!hints.slice(from).some(matches)) return;
              clearTimeout(timer);
              waiting.delete(wake);
              resolve();
            };
            waiting.add(wake);
          });
        },
        close: () => socket.close(),
      };
    },
  };
}
