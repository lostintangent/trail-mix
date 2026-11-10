import { expect, test } from 'bun:test';
import PostalMime from 'postal-mime';
import {
  applySyncEvent,
  memoryIndex,
  referencesOf,
  writeMime,
  type Folder,
  type MemoryIndex,
  type Message,
  type MessageRef,
} from '../../mail/core/index.ts';
import { seededRandom } from '../../../shared/random.ts';
import { SendFailure, type MailProvider } from '../provider.ts';
import {
  DEMO_ACCOUNTS,
  demoMailbox,
  demoServer,
  type DemoKind,
  type DemoMailbox,
} from './provider.ts';

const CREATED = '2026-11-09T17:41:00.000Z';
const YEAR = { since: '2025-11-09T17:41:00.000Z' };

test('the Inbox holds as many messages as asked, and the same inputs make the same mailbox', async () => {
  for (const inbox of [0, 1, 13, 20, 1000]) {
    const first = await everything(open('personal', inbox));
    const again = await everything(open('personal', inbox));

    expect(first.folders.find((folder) => folder.role === 'inbox')?.total).toBe(inbox);
    expect(again).toEqual(first);
  }
});

test('the newest mail shows every state a row can be in, across two stamped accounts', async () => {
  const personal = await everything(open('personal', 20));
  const work = await everything(open('work', 10));
  const messages = [...personal.messages, ...work.messages];
  const conversations = Map.groupBy(messages, (message) => message.conversation);
  const inFolders = (conversation: Message[]) => new Set(conversation.map(({ path }) => path));

  expect(DEMO_ACCOUNTS.personal.stamp).not.toBe(DEMO_ACCOUNTS.work.stamp);
  expect(messages.some(({ path, flags }) => path === 'INBOX' && !flags.seen)).toBe(true);
  expect(messages.some(({ flags }) => flags.flagged)).toBe(true);
  expect(messages.some(({ hasAttachments }) => hasAttachments)).toBe(true);
  expect(messages.some(({ list }) => list?.unsubscribe)).toBe(true);
  expect(messages.some(({ path, flags }) => path === 'Drafts' && flags.draft)).toBe(true);
  expect(
    Math.max(...[...conversations.values()].map((conversation) => conversation.length)),
  ).toBeGreaterThanOrEqual(6);
  // A reply I sent, and a reply I am writing, each sit in the conversation they answer.
  expect(
    [...conversations.values()].some((c) => inFolders(c).has('INBOX') && inFolders(c).has('Sent')),
  ).toBe(true);
  expect(
    [...conversations.values()].some(
      (c) => inFolders(c).has('INBOX') && inFolders(c).has('Drafts'),
    ),
  ).toBe(true);
  expect(personal.folders.find(({ path }) => path === 'Projects/Toy Box')?.parent).toBe('Projects');
});

test('every message says in its bytes what its envelope says', async () => {
  const { provider } = open('personal', 300);
  const { messages } = await everything({ provider });
  const random = seededRandom(1);
  const sample = messages.filter((_, i) => i < 40 || random() < 0.1);

  for (const message of sample) {
    const parsed = await PostalMime.parse(
      await new Response(await provider.body(message)).arrayBuffer(),
    );

    expect({
      messageId: parsed.messageId,
      references: referencesOf(parsed.references, parsed.inReplyTo),
      from: parsed.from?.address,
      subject: parsed.subject,
      date: parsed.date,
      attachments: parsed.attachments.length > 0,
    }).toEqual({
      messageId: message.messageId,
      references: message.references,
      from: message.from.email,
      subject: message.subject,
      date: message.date,
      attachments: message.hasAttachments,
    });
  }
});

test('a reply is never older than what it answers, and a year holds the whole mailbox', async () => {
  for (const [kind, inbox] of [
    ['personal', 1000],
    ['work', 300],
  ] as const) {
    const { provider } = open(kind, inbox);
    const { messages, folders } = await everything({ provider });
    const byId = new Map(messages.map((message) => [message.messageId, message]));

    expect(messages).toHaveLength(folders.reduce((sum, { total }) => sum + total, 0));
    for (const message of messages) {
      for (const id of message.references) {
        const answered = byId.get(id);
        if (answered) expect(answered.date <= message.date).toBe(true);
      }
    }
  }
});

test('saving the same draft again, as a retry does, files it once', async () => {
  const { provider } = open('personal', 20);
  const draft = new TextEncoder().encode(
    writeMime({
      date: CREATED,
      messageId: '<note.1@trailmix.test>',
      from: DEMO_ACCOUNTS.personal.me,
      to: [],
      subject: 'Note to self',
      text: 'Remember the canister.',
      boundary: 'note',
    }),
  );

  const saved = await provider.saveDraft(draft);
  const again = await provider.saveDraft(draft, saved);

  expect(again).toEqual(saved);
  const { messages } = await everything({ provider });
  expect(messages.filter(({ subject }) => subject === 'Note to self')).toHaveLength(1);
});

test('the seeded draft to an unreachable host is refused once, with the reason, and its next try goes', async () => {
  let saved: DemoMailbox | undefined;
  const server = demoServer('personal', demoMailbox('personal', 20, CREATED), (mailbox) => {
    saved = mailbox;
  });
  const { messages } = await everything(server);
  const draft = messages.find(
    ({ path, to }) =>
      path === 'Drafts' && to.some(({ email }) => email.endsWith('@unreachable.example')),
  )!;
  const ref = {
    account: draft.account,
    path: draft.path,
    uidValidity: draft.uidValidity,
    uid: draft.uid,
  };

  const refused = await server.provider
    .submit(ref, draft.messageId)
    .catch((error: unknown) => error);
  expect(refused).toBeInstanceOf(SendFailure);
  expect(refused).toMatchObject({
    passing: false,
    message: 'The mail server refused it: 554 5.4.4 unreachable.example can’t be reached right now',
  });
  expect((await everything(server)).messages).toEqual(messages);

  // The refusal is remembered with the mailbox, so a Mailroom that restarts sends it on Retry.
  const reopened = demoServer('personal', saved!, () => {});
  expect(await reopened.provider.submit(ref, draft.messageId)).toBe('sent');
  await reopened.provider.file(ref, draft.messageId);
  const after = (await everything(reopened)).messages;
  expect(
    after.filter(({ messageId }) => messageId === draft.messageId).map(({ path }) => path),
  ).toEqual(['Sent']);
});

test('the first delete of the seeded Projects is turned away as in use, and its next takes Toy Box too', async () => {
  let saved: DemoMailbox | undefined;
  const server = demoServer('personal', demoMailbox('personal', 400, CREATED), (mailbox) => {
    saved = mailbox;
  });
  const paths = async (provider = server.provider) =>
    (await provider.folders())
      .map(({ path }) => path)
      .filter((path) => path.startsWith('Projects'));
  expect(await paths()).toEqual(['Projects', 'Projects/Toy Box']);
  const filed = (await everything(server)).messages.filter(({ path }) =>
    path.startsWith('Projects'),
  );
  expect(filed.length).toBeGreaterThan(0);

  await expect(server.provider.deleteFolder('Projects')).rejects.toThrow(
    'NO [INUSE] Projects is open in another session',
  );
  expect(await paths()).toEqual(['Projects', 'Projects/Toy Box']);

  // The refusal is remembered with the mailbox, so a Mailroom that restarts deletes it next time.
  const reopened = demoServer('personal', saved!, () => {});
  await reopened.provider.deleteFolder('Projects');
  expect(await paths(reopened.provider)).toEqual([]);
  const { messages } = await everything(reopened);
  expect(messages.filter(({ path }) => path.startsWith('Projects'))).toEqual([]);
});

test('whatever happens to the mailbox, syncing keeps up, and reopening what was saved gives the same server', async () => {
  for (let seed = 1; seed <= 25; seed++) {
    const random = seededRandom(seed);
    const pick = <T>(items: readonly T[]) => items[Math.floor(random() * items.length)];
    let saved: DemoMailbox = demoMailbox('personal', 15, CREATED);
    const server = demoServer('personal', saved, (mailbox) => {
      saved = mailbox;
    });
    const { provider } = server;
    const mailroom = new Mailroom(provider);

    for (let step = 0; step < 30; step++) {
      const held = mailroom.index.messages;
      const some = () => held.filter(() => random() < 0.2) as MessageRef[];
      const paths = (await provider.folders()).map(({ path }) => path);
      const drafts = held.filter(({ path }) => path === 'Drafts');
      const roll = random();
      if (roll < 0.15)
        await provider.setFlags(some(), { seen: random() < 0.5, flagged: random() < 0.3 });
      else if (roll < 0.3) await provider.move(some(), pick(paths) ?? 'INBOX');
      else if (roll < 0.4)
        await server.deliver(message(`delivered ${step}`, pick(held)), pick(paths));
      else if (roll < 0.5) {
        const subject = `draft ${step}`;
        const draft = await provider.saveDraft(message(subject, pick(held)), pick(drafts));
        if (random() < 0.5) {
          await provider.submit(draft, messageIdOf(subject));
          await provider.file(draft, messageIdOf(subject));
        }
      } else if (roll < 0.55) await server.resetUidValidity(pick(paths) ?? 'INBOX');
      else if (roll < 0.6) await provider.createFolder(`Folder ${Math.floor(random() * 3)}`);
      else if (roll < 0.65)
        await provider.renameFolder(`Folder ${Math.floor(random() * 3)}`, `Renamed ${step}`);
      else if (roll < 0.7)
        // Projects' first delete is turned away, and changes nothing.
        await provider
          .deleteFolder(pick(paths.filter((path) => !ROLES.has(path)))!)
          .catch((error: unknown) => {
            if (!String(error).includes('[INUSE]')) throw error;
          });
      // Syncing stops after any batch, as a cold start would stop it.
      else await mailroom.step(random() < 0.5 ? undefined : pick(paths));
    }
    await mailroom.catchUp();

    const fresh = await everything({ provider });
    const kept = JSON.parse(JSON.stringify(saved)) as DemoMailbox;
    expect(sorted(mailroom.index)).toEqual(fresh.messages);
    // The counts beside each folder agree with what the folder holds.
    for (const { path, total, unread } of fresh.folders) {
      const inFolder = fresh.messages.filter((message) => message.path === path);
      expect({ path, total, unread }).toEqual({
        path,
        total: inFolder.length,
        unread: inFolder.filter(({ flags }) => !flags.seen).length,
      });
    }
    expect(await everything(demoServer('personal', kept, () => {}))).toEqual(fresh);
  }
});

const ROLES = new Set(['INBOX', 'Drafts', 'Sent', 'Archive', 'Trash', 'Junk', 'Projects']);

function open(kind: DemoKind, inbox: number) {
  return demoServer(kind, demoMailbox(kind, inbox, CREATED), () => {});
}

/** Everything a Mailroom would know after syncing every folder from scratch. */
async function everything({ provider }: { provider: MailProvider }) {
  const mailroom = new Mailroom(provider);
  await mailroom.catchUp();
  return { folders: mailroom.folders, messages: sorted(mailroom.index) };
}

/**
 * Just enough of a Mailroom to keep an index in step: a cursor per folder, every batch folded, and
 * a folder that disappears forgotten. One batch at a time, so a test can stop it anywhere.
 */
class Mailroom {
  folders: Folder[] = [];
  index: MemoryIndex = memoryIndex([]);
  private cursors = new Map<string, string>();

  constructor(private readonly provider: MailProvider) {}

  /** One batch of one folder, or of every folder. Says whether any is still behind. */
  async step(only?: string): Promise<boolean> {
    const folders = await this.provider.folders();
    for (const gone of this.folders.filter(({ path }) => !folders.some((f) => f.path === path))) {
      this.fold([{ type: 'reset', folder: gone }], folders);
      this.cursors.delete(gone.path);
    }
    this.folders = folders;
    let behind = false;
    for (const folder of folders.filter(({ path }) => only === undefined || path === only)) {
      const batch = await this.provider.sync(
        folder.path,
        this.cursors.get(folder.path) ?? null,
        YEAR,
      );
      this.fold(batch.events, folders);
      this.cursors.set(folder.path, batch.cursor);
      behind ||= batch.more;
    }
    return behind;
  }

  async catchUp() {
    while (await this.step());
  }

  private fold(events: Parameters<typeof applySyncEvent>[1][], folders: Folder[]) {
    let index = memoryIndex(folders, this.index.messages);
    for (const event of events) index = index.apply(applySyncEvent(index, event));
    this.index = index;
  }
}

/** A message from outside, replying to `answering` when given. */
const messageIdOf = (subject: string) => `<${subject.replace(/\W/g, '.')}@example.com>`;

function message(subject: string, answering?: Message): Uint8Array {
  return new TextEncoder().encode(
    writeMime({
      date: CREATED,
      messageId: messageIdOf(subject),
      from: { name: 'Ada Park', email: 'ada@example.com' },
      to: [DEMO_ACCOUNTS.personal.me],
      subject,
      references: answering?.messageId ? [...answering.references, answering.messageId] : [],
      text: `About ${subject}.`,
      boundary: 'test',
    }),
  );
}

function sorted(index: MemoryIndex): Message[] {
  const key = ({ account, path, uidValidity, uid }: Message) =>
    `${account}/${path}/${uidValidity}/${uid}`;
  return [...index.messages].sort((a, b) => key(a).localeCompare(key(b)));
}
