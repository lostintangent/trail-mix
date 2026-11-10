// The provider contract suite: one specification every MailProvider meets, run against each one
// through a harness that plays the rest of the world, meaning mail arriving, other clients and the
// host itself. A provider passes when the index it feeds would mirror the mailbox.
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Envelope, MessageRef, SyncEvent } from '../../src/features/mail/core/index.ts';
import type { Cursor, MailProvider } from '../../src/features/providers/index.ts';

export type Harness = {
  provider: MailProvider;
  /** The account's own address. Drafts are sent to it, so nothing leaves the host. */
  address: string;
  /** Empties the mailbox before each test. */
  reset(): Promise<void>;
  /** Files a raw message in a folder, as mail arriving from elsewhere would. */
  deliver(raw: string, folder?: string): Promise<void>;
  /** Removes a message by Message-ID, as another client would. */
  expunge(folder: string, messageId: string): Promise<void>;
  /** Numbers a folder's UIDs again, which tells every client to forget what it knew. */
  resetUidValidity(folder: string): Promise<void>;
  /** Has the host accept a message for delivery without the provider, as a send cut short would. */
  submit(raw: string): Promise<void>;
  close(): Promise<void>;
};

const WINDOW = { since: '2000-01-01T00:00:00Z' };

/**
 * Describes the contract for one provider. `timeout` is how long each case may take, which a
 * provider talking to a real server needs more of than Bun's default.
 */
export function describeContract(
  name: string,
  harness: () => Promise<Harness>,
  { timeout }: { timeout?: number } = {},
) {
  describe(`${name} meets the provider contract`, () => {
    let h: Harness | undefined;
    let provider: MailProvider;

    // Bun moves on from a case that runs out of time while its work carries on. So each case runs
    // in its own async context, and the world refuses one that is no longer the current case, which
    // stops it at its next call instead of letting it fill the next case's mailbox.
    const cases = new AsyncLocalStorage<string>();
    let current: string | undefined;
    const it = (title: string, body: () => Promise<void>) =>
      test(
        title,
        () => {
          current = title;
          return cases.run(title, body);
        },
        timeout,
      );

    // The first one starts the harness's server, which can take a while.
    beforeEach(async () => {
      h ??= await harness();
      provider = h.provider;
      await h.reset();
    }, 60_000);
    afterAll(() => h?.close());
    const world = () => {
      if (!h) throw new Error('no harness');
      const running = cases.getStore();
      if (running !== current) throw new Error(`“${running}” ran out of time, so it stops here.`);
      return h;
    };

    /** Syncs a folder until nothing remains, as the Mailroom does, from a cursor or from scratch. */
    async function syncAll(path: string, cursor: Cursor | null = null) {
      const events: SyncEvent[] = [];
      for (let batches = 1; ; batches++) {
        const result = await provider.sync(path, cursor, WINDOW);
        events.push(...result.events);
        cursor = result.cursor;
        if (!result.more) return { events, cursor, batches };
      }
    }
    const arrived = (events: SyncEvent[]) =>
      events.flatMap((e) => (e.type === 'message' ? [e.envelope] : []));
    const kinds = (events: SyncEvent[]) => events.map((e) => e.type);
    async function only(path: string, subject: string): Promise<Envelope> {
      const found = arrived((await syncAll(path)).events).filter((e) => e.subject === subject);
      expect(found).toHaveLength(1);
      return found[0]!;
    }
    async function count(path: string, messageId: string) {
      return arrived((await syncAll(path)).events).filter((e) => e.messageId === messageId).length;
    }
    async function role(name: string) {
      const folder = (await provider.folders()).find((f) => f.role === name);
      if (!folder) throw new Error(`no ${name} folder`);
      return folder.path;
    }

    it('lists every folder, each standard role on exactly one', async () => {
      const roles = (await provider.folders()).flatMap((f) => (f.role ? [f.role] : []));
      expect(roles.sort()).toEqual(['archive', 'drafts', 'inbox', 'junk', 'sent', 'trash']);
    });

    it('reports a folder newest first, as envelopes a list and a conversation need', async () => {
      await world().deliver(message({ id: 'first', subject: 'First', minutesAgo: 30 }));
      await world().deliver(
        message({
          id: 'second',
          subject: 'Second',
          minutesAgo: 20,
          inReplyTo: 'first',
          list: 'news.example.com',
          text: '> quoted\r\nThe second message says hello.',
          attachment: true,
        }),
      );
      const { events } = await syncAll('INBOX');
      expect(kinds(events)).toEqual(['reset', 'message', 'message']);
      const [second, first] = arrived(events);
      expect(first?.subject).toBe('First');
      expect(first?.hasAttachments).toBe(false);
      expect(second).toMatchObject({
        path: 'INBOX',
        messageId: '<second@example.com>',
        references: ['<first@example.com>'],
        from: { name: 'Ada Park', email: 'ada@example.com' },
        to: [{ email: 'me@trailmix.test' }],
        subject: 'Second',
        date: '2026-11-09T11:40:00.000Z',
        preview: 'The second message says hello.',
        flags: { seen: false, flagged: false, answered: false, draft: false },
        hasAttachments: true,
        list: { id: 'news.example.com' },
      });
    });

    it('reports a large folder in bounded batches that together hold every message once', async () => {
      for (let i = 0; i < 520; i++) {
        await world().deliver(message({ id: `bulk-${i}`, subject: `Bulk ${i}` }));
      }
      const { events, batches } = await syncAll('INBOX');
      const ids = arrived(events).map((e) => e.messageId);
      expect(batches).toBeGreaterThan(1);
      expect(ids).toHaveLength(520);
      expect(new Set(ids).size).toBe(520);
    });

    it('reports only what changed since the cursor, and nothing when nothing did', async () => {
      await world().deliver(message({ id: 'old', subject: 'Old' }));
      const { cursor } = await syncAll('INBOX');
      await world().deliver(message({ id: 'new', subject: 'New' }));
      const next = await syncAll('INBOX', cursor);
      expect(arrived(next.events).map((e) => e.subject)).toEqual(['New']);
      expect((await syncAll('INBOX', next.cursor)).events).toEqual([]);
    });

    it('changes flags, reports each change once, and setting them again changes nothing', async () => {
      await world().deliver(message({ id: 'flag-me', subject: 'Flag me' }));
      const first = await syncAll('INBOX');
      const ref = refOf(arrived(first.events)[0]!);
      await provider.setFlags([ref], { seen: true, flagged: true });
      const second = await syncAll('INBOX', first.cursor);
      expect(second.events).toEqual([
        { type: 'flags', ref, flags: { seen: true, flagged: true, answered: false, draft: false } },
      ]);
      await provider.setFlags([ref], { seen: true, flagged: true });
      expect((await syncAll('INBOX', second.cursor)).events).toEqual([]);
      await provider.setFlags([ref], { flagged: false });
      expect((await syncAll('INBOX', second.cursor)).events).toEqual([
        {
          type: 'flags',
          ref,
          flags: { seen: true, flagged: false, answered: false, draft: false },
        },
      ]);
    });

    it('reports a message another client removed as gone', async () => {
      await world().deliver(message({ id: 'keep', subject: 'Keep' }));
      await world().deliver(message({ id: 'remove', subject: 'Remove' }));
      const { events, cursor } = await syncAll('INBOX');
      const removed = arrived(events).find((e) => e.subject === 'Remove')!;
      await world().expunge('INBOX', '<remove@example.com>');
      expect((await syncAll('INBOX', cursor)).events).toEqual([
        { type: 'gone', ref: refOf(removed) },
      ]);
    });

    it('starts a folder over when its UIDVALIDITY changes', async () => {
      await world().deliver(message({ id: 'renumbered', subject: 'Renumbered' }));
      const before = await syncAll('INBOX');
      await world().resetUidValidity('INBOX');
      const after = await syncAll('INBOX', before.cursor);
      expect(kinds(after.events)).toEqual(['reset', 'message']);
      const [again] = arrived(after.events);
      expect(again?.messageId).toBe('<renumbered@example.com>');
      expect(again?.uidValidity).not.toBe(arrived(before.events)[0]?.uidValidity);
    });

    it('moves messages to another folder, and moving them again does nothing', async () => {
      await world().deliver(message({ id: 'move-me', subject: 'Move me' }));
      const { events, cursor } = await syncAll('INBOX');
      const ref = refOf(arrived(events)[0]!);
      const archive = await role('archive');
      const [moved] = await provider.move([ref], archive);
      expect((await syncAll('INBOX', cursor)).events).toEqual([{ type: 'gone', ref }]);
      const landed = await only(archive, 'Move me');
      expect(moved).toEqual({ from: ref, to: refOf(landed) });
      expect(await provider.move([ref], archive)).toEqual([]);
      expect(await count(archive, '<move-me@example.com>')).toBe(1);
    });

    it('says where each message moved, so moving each back restores both lists', async () => {
      await world().deliver(message({ id: 'keep', subject: 'Keep', minutesAgo: 2 }));
      await world().deliver(message({ id: 'one', subject: 'One', minutesAgo: 1 }));
      await world().deliver(message({ id: 'two', subject: 'Two' }));
      const archive = await role('archive');
      const listed = async () => ({
        inbox: arrived((await syncAll('INBOX')).events)
          .map((e) => e.messageId)
          .sort(),
        archive: arrived((await syncAll(archive)).events)
          .map((e) => e.messageId)
          .sort(),
      });
      const before = await listed();
      const chosen = arrived((await syncAll('INBOX')).events)
        .filter((e) => e.subject !== 'Keep')
        .map(refOf);

      const moved = await provider.move(chosen, archive);
      expect(keys(moved.map(({ from }) => from))).toEqual(keys(chosen));
      const inArchive = arrived((await syncAll(archive)).events).map(refOf);
      expect(keys(moved.map(({ to }) => to))).toEqual(keys(inArchive));

      // Undo, as the browser does it: each message back to the folder it came from.
      const back = await provider.move(
        moved.map(({ to }) => to),
        'INBOX',
      );
      expect(keys(back.map(({ from }) => from))).toEqual(keys(moved.map(({ to }) => to)));
      expect(await listed()).toEqual(before);
    });

    it('saves a draft, and a new version replaces the old one', async () => {
      const drafts = await role('drafts');
      const draft = (subject: string) =>
        bytes(message({ id: 'draft', subject, to: world().address }));
      const first = await provider.saveDraft(draft('Draft one'));
      expect(first.path).toBe(drafts);
      expect((await only(drafts, 'Draft one')).flags.draft).toBe(true);
      const second = await provider.saveDraft(draft('Draft two'), first);
      const listed = arrived((await syncAll(drafts)).events);
      expect(listed.map((e) => e.subject)).toEqual(['Draft two']);
      expect(refOf(listed[0]!)).toEqual(second);
      // Replacing a draft that is already gone only saves the new one.
      await provider.saveDraft(draft('Draft three'), first);
      expect(arrived((await syncAll(drafts)).events)).toHaveLength(2);
    });

    it('sends a draft once, with one copy in Sent and the draft gone, however often it is sent', async () => {
      const { address } = world();
      const id = '<send-me@example.com>';
      const draft = await provider.saveDraft(
        bytes(message({ id: 'send-me', subject: 'Send me', from: address, to: address })),
      );
      await provider.send(draft);
      await provider.send(draft);
      expect(await count('INBOX', id)).toBe(1);
      expect(await count(await role('sent'), id)).toBe(1);
      expect(await count(await role('drafts'), id)).toBe(0);
    });

    it('a send cut short after the host accepted it delivers again, but files one copy', async () => {
      const { address } = world();
      const id = '<interrupted@example.com>';
      const raw = message({
        id: 'interrupted',
        subject: 'Interrupted',
        from: address,
        to: address,
      });
      const draft = await provider.saveDraft(bytes(raw));
      // The host accepted the message, then the provider stopped before filing it in Sent.
      await world().submit(raw);
      await provider.send(draft);
      expect(await count('INBOX', id)).toBe(2);
      expect(await count(await role('sent'), id)).toBe(1);
      expect(await count(await role('drafts'), id)).toBe(0);
    });

    it('keeps Bcc recipients out of what it delivers and files', async () => {
      const { address } = world();
      const raw = message({
        id: 'blind',
        subject: 'Blind',
        from: address,
        to: address,
        bcc: address,
      });
      await provider.send(await provider.saveDraft(bytes(raw)));
      for (const folder of ['INBOX', await role('sent')]) {
        const text = await new Response(
          await provider.body(refOf(await only(folder, 'Blind'))),
        ).text();
        expect(text).not.toMatch(/^bcc:/im);
      }
    });

    it('returns the raw message', async () => {
      await world().deliver(message({ id: 'raw', subject: 'Raw', text: 'Exactly these words.' }));
      const envelope = await only('INBOX', 'Raw');
      const text = await new Response(await provider.body(refOf(envelope))).text();
      expect(text).toContain('Message-ID: <raw@example.com>');
      expect(text).toContain('Exactly these words.');
    });

    it('reading a message leaves it unread', async () => {
      await world().deliver(message({ id: 'unread', subject: 'Unread' }));
      const { events, cursor } = await syncAll('INBOX');
      await new Response(await provider.body(refOf(arrived(events)[0]!))).text();
      expect((await syncAll('INBOX', cursor)).events).toEqual([]);
      expect((await only('INBOX', 'Unread')).flags.seen).toBe(false);
    });

    it('finds a phrase that appears only inside a message', async () => {
      await world().deliver(
        message({ id: 'needle', subject: 'Plain', text: 'A periwinkle teapot.' }),
      );
      await world().deliver(message({ id: 'hay', subject: 'Plain too', text: 'Nothing here.' }));
      const envelope = await only('INBOX', 'Plain');
      expect(await provider.search('INBOX', 'periwinkle')).toEqual([envelope.uid]);
    });

    it('tells a watcher about new mail until it stops watching', async () => {
      let changes = 0;
      const stop = provider.watch('INBOX', () => changes++);
      await Bun.sleep(1000);
      await world().deliver(message({ id: 'watched', subject: 'Watched' }));
      await until(() => changes > 0);
      stop();
      const seen = changes;
      await world().deliver(message({ id: 'unwatched', subject: 'Unwatched' }));
      await Bun.sleep(1500);
      expect(changes).toBe(seen);
    });

    it('creates, renames and deletes nested folders, each safe to repeat', async () => {
      await provider.createFolder('Projects');
      await provider.createFolder('Projects/Toy Box');
      await provider.createFolder('Projects/Toy Box');
      expect((await provider.folders()).find((f) => f.path === 'Projects/Toy Box')).toMatchObject({
        name: 'Toy Box',
        parent: 'Projects',
      });
      await provider.renameFolder('Projects/Toy Box', 'Projects/Trail Mix');
      await provider.renameFolder('Projects/Toy Box', 'Projects/Trail Mix');
      await provider.deleteFolder('Projects/Trail Mix');
      await provider.deleteFolder('Projects/Trail Mix');
      const paths = (await provider.folders()).map((f) => f.path);
      expect(paths).toContain('Projects');
      expect(paths).not.toContain('Projects/Toy Box');
      expect(paths).not.toContain('Projects/Trail Mix');
    });
  });
}

/** Refs as comparable keys, in one order. */
const keys = (refs: MessageRef[]) =>
  refs.map(({ path, uidValidity, uid }) => `${path} ${uidValidity} ${uid}`).sort();

const refOf = ({ account, path, uidValidity, uid }: MessageRef): MessageRef => ({
  account,
  path,
  uidValidity,
  uid,
});
const bytes = (raw: string) => new TextEncoder().encode(raw);

async function until(done: () => boolean, ms = 5000) {
  const deadline = Date.now() + ms;
  while (!done()) {
    if (Date.now() > deadline) throw new Error(`not within ${ms} ms`);
    await Bun.sleep(50);
  }
}

/** A plain RFC 5322 message, with a file attached when asked. Its id is `<id@example.com>`. */
export function message(fields: {
  id: string;
  subject: string;
  from?: string;
  to?: string;
  bcc?: string;
  inReplyTo?: string;
  list?: string;
  text?: string;
  attachment?: boolean;
  minutesAgo?: number;
}): string {
  const date = new Date(Date.UTC(2026, 10, 9, 12) - (fields.minutesAgo ?? 0) * 60_000);
  const headers = [
    `From: ${fields.from ?? 'Ada Park <ada@example.com>'}`,
    `To: ${fields.to ?? 'me@trailmix.test'}`,
    ...(fields.bcc ? [`Bcc: ${fields.bcc}`] : []),
    `Subject: ${fields.subject}`,
    `Date: ${date.toUTCString()}`,
    `Message-ID: <${fields.id}@example.com>`,
    ...(fields.inReplyTo ? [`In-Reply-To: <${fields.inReplyTo}@example.com>`] : []),
    ...(fields.list ? [`List-Id: News <${fields.list}>`] : []),
    'MIME-Version: 1.0',
  ];
  const text = fields.text ?? `This is ${fields.subject}.`;
  if (!fields.attachment) {
    return [...headers, 'Content-Type: text/plain; charset=utf-8', '', text, ''].join('\r\n');
  }
  return [
    ...headers,
    'Content-Type: multipart/mixed; boundary="part"',
    '',
    '--part',
    'Content-Type: text/plain; charset=utf-8',
    '',
    text,
    '--part',
    'Content-Type: application/pdf; name="plan.pdf"',
    'Content-Disposition: attachment; filename="plan.pdf"',
    'Content-Transfer-Encoding: base64',
    '',
    btoa('%PDF-1.4 a plan'),
    '--part--',
    '',
  ].join('\r\n');
}
