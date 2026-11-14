// The provider contract suite: one specification every MailProvider meets, run against each one
// through a harness that plays the rest of the world, meaning mail arriving, other clients and the
// host itself. A provider passes when the index it feeds would mirror the mailbox.
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Envelope, MessageRef, SyncEvent } from '../../src/features/mail/core/index.ts';
import {
  FIRST_SYNC_BATCH,
  SEARCH_LIMIT,
  type Cursor,
  type MailProvider,
} from '../../src/features/providers/index.ts';

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
  /**
   * Whether the host files its own copy of what it accepts in Sent, as Zoho and Outlook do, and
   * the provider knows it. The host files it only once `settle` lets a moment pass.
   */
  filesSent: boolean;
  /** Lets a moment pass, in which a host that files its own copy in Sent files what it accepted. */
  settle(): Promise<void>;
  /** Turns the host's own copies in Sent off until the next reset, as a Zoho member can. */
  stopFilingSent(): Promise<void>;
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

    it('previews the HTML when the plain text has no words to read, and decodes what either escapes', async () => {
      await world().deliver(
        message({
          id: 'padded',
          subject: 'Padded',
          // A newsletter's plain text can be nothing but its HTML's padding, written as entities.
          text: '&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;\r\n\r\n',
          html: '<p>Upper Division Social Justice Day</p><p>Dear Families,</p>',
        }),
      );
      await world().deliver(
        message({
          id: 'escaped',
          subject: 'Escaped',
          text: 'Jonathan, you&#39;re invited &amp; welcome',
        }),
      );
      expect((await only('INBOX', 'Padded')).preview).toBe(
        'Upper Division Social Justice Day Dear Families,',
      );
      expect((await only('INBOX', 'Escaped')).preview).toBe("Jonathan, you're invited & welcome");
    });

    it('reports a large folder in bounded batches that together hold every message once', async () => {
      for (let i = 0; i < 520; i++) {
        await world().deliver(message({ id: `bulk-${i}`, subject: `Bulk ${i}` }));
      }
      // A folder starting over shows its newest mail first, in a small batch.
      const first = await provider.sync('INBOX', null, WINDOW);
      const newest = arrived(first.events);
      expect(newest.length).toBeGreaterThan(0);
      expect(newest.length).toBeLessThanOrEqual(FIRST_SYNC_BATCH);
      expect(newest[0]!.subject).toBe('Bulk 519');
      expect(first.more).toBe(true);

      const rest = await syncAll('INBOX', first.cursor);
      const ids = [...newest, ...arrived(rest.events)].map((e) => e.messageId);
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

    it('saves a draft, and discards the one a newer version replaced', async () => {
      const drafts = await role('drafts');
      const draft = (subject: string) =>
        bytes(message({ id: 'draft', subject, to: world().address }));
      const first = await provider.saveDraft(draft('Draft one'));
      expect(first.path).toBe(drafts);
      expect((await only(drafts, 'Draft one')).flags.draft).toBe(true);
      const second = await provider.saveDraft(draft('Draft two'));
      // Until the discard, the server holds both versions, never neither.
      expect(arrived((await syncAll(drafts)).events)).toHaveLength(2);
      await provider.discardDraft(first);
      const listed = arrived((await syncAll(drafts)).events);
      expect(listed.map((e) => e.subject)).toEqual(['Draft two']);
      expect(refOf(listed[0]!)).toEqual(second);
      // Discarding a draft that is already gone, as a retry does, changes nothing.
      await provider.discardDraft(first);
      expect(arrived((await syncAll(drafts)).events).map(refOf)).toEqual([second]);
    });

    it('discards only a draft, so a wrong ref costs no message', async () => {
      await world().deliver(message({ id: 'kept', subject: 'Kept' }));
      const kept = refOf(await only('INBOX', 'Kept'));
      await provider.discardDraft(kept);
      expect((await only('INBOX', 'Kept')).messageId).toBe('<kept@example.com>');
    });

    // Sending is two steps, and the Outbox records the host's acceptance between them. A restart can
    // land before either step, inside either, or after both, so each case below is one of those
    // points: the steps that ran before it, then the steps that run again.
    /** A draft to the account itself, saved, with its Message-ID. */
    async function drafted(id: string, fields: { bcc?: string } = {}) {
      const { address } = world();
      const raw = message({ id, subject: id, from: address, to: address, ...fields });
      return { raw, id: `<${id}@example.com>`, draft: await provider.saveDraft(bytes(raw)) };
    }
    /**
     * Where one Message-ID is, once the host has filed what it files: how many times it arrived, its
     * copies in Sent, and its drafts.
     */
    async function whereIs(id: string) {
      await world().settle();
      return {
        delivered: await count('INBOX', id),
        sent: await count(await role('sent'), id),
        drafts: await count(await role('drafts'), id),
      };
    }
    /**
     * Files a submitted draft as the Outbox does: while it waits for a host that files its own
     * copy, a moment passes, and then the wait is over.
     */
    async function fileCopy(draft: MessageRef, id: string) {
      if ((await provider.file(draft, id, true)) === 'filed') return;
      await world().settle();
      expect(await provider.file(draft, id, false)).toBe('filed');
    }

    it('submits a draft and files one copy, and once it is filed neither step delivers again', async () => {
      const { id, draft } = await drafted('send-me');
      expect(await provider.submit(draft, id)).toBe('sent');
      await fileCopy(draft, id);
      expect(await whereIs(id)).toEqual({ delivered: 1, sent: 1, drafts: 0 });
      expect(await provider.file(draft, id, true)).toBe('filed');
      expect(await provider.submit(draft, id)).toBe('sent');
      expect(await whereIs(id)).toEqual({ delivered: 1, sent: 1, drafts: 0 });
    });

    it('files after a restart or a failed filing, and delivers nothing again', async () => {
      const { id, draft } = await drafted('accepted');
      await provider.submit(draft, id);
      // A failed APPEND stores nothing, so filing that failed leaves what a restart before it does.
      expect(await whereIs(id)).toMatchObject({ delivered: 1, drafts: 1 });
      await fileCopy(draft, id);
      expect(await whereIs(id)).toEqual({ delivered: 1, sent: 1, drafts: 0 });
    });

    it('files no second copy after a restart between filing the copy and removing the draft', async () => {
      const { raw, id, draft } = await drafted('half-filed');
      await provider.submit(draft, id);
      // Filing had appended its copy, unless the host files its own, when the restart came.
      if (!world().filesSent) await world().deliver(raw, await role('sent'));
      await fileCopy(draft, id);
      expect(await whereIs(id)).toEqual({ delivered: 1, sent: 1, drafts: 0 });
    });

    it('submits again after the host accepted it unseen only if Sent holds no copy', async () => {
      const { raw, id, draft } = await drafted('unrecorded');
      // The host accepted the message and the Outbox never heard, so a while later the member
      // chose Retry.
      await world().submit(raw);
      await world().settle();
      expect(await provider.submit(draft, id)).toBe('sent');
      await fileCopy(draft, id);
      const { filesSent } = world();
      expect(await whereIs(id)).toEqual({ delivered: filesSent ? 1 : 2, sent: 1, drafts: 0 });
    });

    it('says a draft that is gone is missing, and sends nothing', async () => {
      const { id, draft } = await drafted('withdrawn');
      await world().expunge(await role('drafts'), id);
      expect(await provider.submit(draft, id)).toBe('missing');
      expect(await provider.file(draft, id, true)).toBe('filed');
      expect(await whereIs(id)).toEqual({ delivered: 0, sent: 0, drafts: 0 });
    });

    it('counts a draft as sent once Sent holds its Message-ID, and delivers nothing', async () => {
      const { raw, id, draft } = await drafted('sent-elsewhere');
      await world().deliver(raw, await role('sent'));
      expect(await provider.submit(draft, id)).toBe('sent');
      await world().expunge(await role('drafts'), id);
      expect(await provider.submit(draft, id)).toBe('sent');
      expect(await whereIs(id)).toEqual({ delivered: 0, sent: 1, drafts: 0 });
    });

    it('finds the copy in Sent that arrived after it last read Sent, and delivers nothing', async () => {
      const { raw, id, draft } = await drafted('filed-since');
      const sent = await role('sent');
      expect(await count(sent, id)).toBe(0);
      // The host files its copy while the provider still has Sent open from that read.
      await world().deliver(raw, sent);
      expect(await provider.submit(draft, id)).toBe('sent');
      expect(await provider.file(draft, id, true)).toBe('filed');
      expect(await whereIs(id)).toEqual({ delivered: 0, sent: 1, drafts: 0 });
    });

    it('waits for a host that files its own copy in Sent, and files none of its own once it has', async () => {
      const { id, draft } = await drafted('waited-for');
      await provider.submit(draft, id);
      const { filesSent } = world();
      expect(await provider.file(draft, id, true)).toBe(filesSent ? 'unfiled' : 'filed');
      if (filesSent) {
        // While it waits, the draft stays, and nothing of Trail Mix's is in Sent.
        expect(await count(await role('drafts'), id)).toBe(1);
        expect(await count(await role('sent'), id)).toBe(0);
        await world().settle();
        expect(await provider.file(draft, id, true)).toBe('filed');
      }
      expect(await whereIs(id)).toEqual({ delivered: 1, sent: 1, drafts: 0 });
    });

    it('files a copy itself once the wait is over, when the host’s own copies are off', async () => {
      await world().stopFilingSent();
      const { id, draft } = await drafted('never-filed');
      await provider.submit(draft, id);
      await world().settle();
      expect(await provider.file(draft, id, true)).toBe(world().filesSent ? 'unfiled' : 'filed');
      expect(await provider.file(draft, id, false)).toBe('filed');
      expect(await whereIs(id)).toEqual({ delivered: 1, sent: 1, drafts: 0 });
    });

    it('finds a copy in Sent among its newest that the host’s search cannot match', async () => {
      const { raw, id, draft } = await drafted('unsearchable');
      // The copy names itself without angle brackets, so a search for the Message-ID misses it.
      const copy = raw.replace(`Message-ID: ${id}`, `Message-ID: ${id.slice(1, -1)}`);
      await world().deliver(copy, await role('sent'));
      expect(await provider.submit(draft, id)).toBe('sent');
      expect(await provider.file(draft, id, true)).toBe('filed');
      expect(await whereIs(id)).toEqual({ delivered: 0, sent: 1, drafts: 0 });
    });

    it('keeps Bcc recipients out of what it delivers and files', async () => {
      const { address } = world();
      const { id, draft } = await drafted('blind', { bcc: address });
      await provider.submit(draft, id);
      await fileCopy(draft, id);
      await world().settle();
      for (const folder of ['INBOX', await role('sent')]) {
        const text = await new Response(
          await provider.body(refOf(await only(folder, 'blind'))),
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
      expect(await provider.search('INBOX', 'periwinkle')).toEqual([envelope]);
    });

    it('reports only the newest hits of a search that finds many, newest first', async () => {
      for (let i = 0; i <= SEARCH_LIMIT; i++) {
        await world().deliver(
          message({ id: `many-${i}`, subject: `Many ${i}`, minutesAgo: SEARCH_LIMIT - i }),
        );
      }
      const found = await provider.search('INBOX', 'many');
      expect(found.map(({ subject }) => subject)).toEqual(
        Array.from({ length: SEARCH_LIMIT }, (_, i) => `Many ${SEARCH_LIMIT - i}`),
      );
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
        delimiter: '/',
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

    it('renames a folder with the folders inside it, and deletes it with them and their mail', async () => {
      await provider.createFolder('Trips');
      await provider.createFolder('Trips/Japan');
      await provider.createFolder('Trips/Japan/Kyoto');
      await world().deliver(message({ id: 'kyoto', subject: 'Kyoto' }), 'Trips/Japan/Kyoto');
      await provider.renameFolder('Trips', 'Travel');
      const renamed: string[] = (await provider.folders()).map((f) => f.path);
      expect(renamed.filter((path) => path.startsWith('Travel')).toSorted()).toEqual([
        'Travel',
        'Travel/Japan',
        'Travel/Japan/Kyoto',
      ]);
      expect(renamed.filter((path) => path.startsWith('Trips'))).toEqual([]);
      expect((await provider.folders()).find((f) => f.path === 'Travel/Japan/Kyoto')?.total).toBe(
        1,
      );

      // Some servers keep a parent whose children are still there, so the children go first.
      await provider.deleteFolder('Travel');
      await provider.deleteFolder('Travel');
      expect((await provider.folders()).filter((f) => f.path.startsWith('Travel'))).toEqual([]);
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

/**
 * A plain RFC 5322 message, with HTML beside its text or a file attached when asked. Its id is
 * `<id@example.com>`.
 */
export function message(fields: {
  id: string;
  subject: string;
  from?: string;
  to?: string;
  bcc?: string;
  inReplyTo?: string;
  list?: string;
  text?: string;
  html?: string;
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
  if (fields.html !== undefined) {
    return [
      ...headers,
      'Content-Type: multipart/alternative; boundary="part"',
      '',
      '--part',
      'Content-Type: text/plain; charset=utf-8',
      '',
      text,
      '--part',
      'Content-Type: text/html; charset=utf-8',
      '',
      fields.html,
      '--part--',
      '',
    ].join('\r\n');
  }
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
