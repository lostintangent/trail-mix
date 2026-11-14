import PostalMime, { type Address as PostalAddress } from 'postal-mime';
import { messageOf } from '../../composer/index.ts';
import {
  messageIdOf,
  referencesOf,
  sameRef,
  writeMime,
  type AccountId,
  type Envelope,
  type Message,
  type MessageRef,
  type MimeAttachment,
  type Outgoing,
} from '../../mail/core/index.ts';
import type { MailProvider } from '../../providers/index.ts';
import type { DraftUpload } from '../client/contract.ts';
import type { AccountBook } from './accounts.ts';
import type { BodyCache } from './bodies.ts';
import type { EnvelopeIndex } from './envelope-index.ts';
import * as input from './input.ts';
import type { OutboxQueue } from './outbox.ts';
import { replacedDrafts } from './replaced.ts';
import { report } from './report.ts';
import type { Sql } from './schema.ts';
import type { SyncQueue } from './sync.ts';

/**
 * Saving drafts: each save written as mail and filed in its account's Drafts, in place of the
 * version before it, which its server is then owed a discard of. A save is named by the id it was
 * asked under, so asking again never files a second copy.
 */
export type SavingDrafts = ReturnType<typeof savingDrafts>;

/** A draft just filed, with what a send of it names. */
export type FiledDraft = {
  saved: MessageRef;
  /** The bytes filed, unless the draft was found, as filed by an ask before. */
  raw?: Uint8Array;
  replacing?: MessageRef;
  addressing: Addressing;
};

/** Who a draft is to and what it's about, as its send keeps them, and its Message-ID. */
export type Addressing = Pick<Outgoing, 'messageId' | 'to' | 'subject'>;

/**
 * The id a save is asked under, its own or the press of Send that carries it, whether an ask before
 * may have filed it, as one whose answer was lost or a press a restart cut short may have, and
 * whether the id is a press, which the Outbox keeps.
 */
export type Asked = { id: string; mayBeFiled: boolean; isPress: boolean };

export function savingDrafts(ports: {
  sql: Sql;
  book: Pick<AccountBook, 'get'>;
  store: EnvelopeIndex;
  provider: (account: AccountId) => Promise<MailProvider>;
  bodies: Pick<BodyCache, 'bytes' | 'attachment' | 'keep' | 'filed' | 'replaced'>;
  /** A message the index holds, or the last full-text search found, which a save may answer. */
  known: (ref: MessageRef) => Message | undefined;
  /** The Outbox's hold on a draft on its way, and its release once a newer version replaces it. */
  outbox: Pick<OutboxQueue, 'holds' | 'release'>;
  sync: Pick<SyncQueue, 'folder'>;
  /** Owes the sync work it is given, with the alarm armed before it is done. */
  owe: (owing: () => void) => Promise<void>;
  /** Has every write so far reach the disk before the Mailroom goes on. */
  flush: () => Promise<void>;
}) {
  const { store, bodies } = ports;
  const replaced = replacedDrafts(ports.sql);
  /** Saves being filed, by the id they were asked under. Memory alone holds them. */
  const saving = new Map<string, Promise<MessageRef>>();

  /**
   * Writes a draft as mail and files it in Drafts, in place of the version before it, with what a
   * send of it needs to know. Everything it refuses, it refuses before it files anything.
   *
   * A save filed twice would leave a stray copy in Drafts, so a save that may have been filed
   * already finds its copy instead, by a Message-ID Trail Mix made. A save is named by the id it
   * was asked under, its own or the press that carries it, and one that an ask before may have
   * filed looks first, before it reads anything from the version it replaces, which the replacing
   * may have let go. A save whose filing fails looks after, since the host may have filed it and
   * lost only the answer.
   */
  const file = async (
    draft: DraftUpload,
    replaces: MessageRef | undefined,
    asked: Asked,
  ): Promise<FiledDraft> => {
    const checked = input.draftOf(draft);
    const older = input.optional(replaces, input.refOf);
    const account = ports.book.get(checked.account)?.account;
    if (!account) throw new Error('There is no such account.');
    if (older && older.account !== account.id) {
      throw new TypeError('A draft replaces only a draft of the account it is from.');
    }
    const domain = account.address.split('@')[1]!;
    const messageId = await messageIdFor(asked.id, domain);
    const addressing = { messageId, to: [...checked.to, ...checked.cc], subject: checked.subject };
    if (older && ports.outbox.holds(older)) {
      throw new Error('That draft is on its way. Undo the send to change it.');
    }
    if (asked.mayBeFiled) {
      const held = await (await ports.provider(account.id)).findDraft(messageId);
      if (held) return { ...filed(held, older), addressing };
    }
    const known = checked.inReplyTo && ports.known(checked.inReplyTo);
    if (checked.inReplyTo && !known && !older) {
      throw new Error('The message this replies to is gone.');
    }
    const parent = known || (older && (await answeredBy(older)));
    const attachments: MimeAttachment[] = [];
    for (const attachment of checked.attachments) {
      if ('file' in attachment) {
        const { name, type, content } = attachment.file;
        const { contentId } = attachment;
        attachments.push({ name, type, content, ...(contentId ? { contentId } : {}) });
        continue;
      }
      const held = await bodies.attachment(attachment.in, Number(attachment.id));
      if (!held) throw new Error('An attachment this draft carried over is gone.');
      attachments.push(held);
    }
    const message = messageOf(
      {
        from: { ...(account.fromName ? { name: account.fromName } : {}), email: account.address },
        to: checked.to,
        cc: checked.cc,
        bcc: checked.bcc,
        subject: checked.subject,
        markdown: checked.markdown,
        ...(parent ? { parent } : {}),
        attachments,
      },
      { date: new Date().toISOString(), messageId, boundary: crypto.randomUUID() },
    );
    const raw = new TextEncoder().encode(writeMime(message));
    const provider = await ports.provider(account.id);
    // A restart before the press is on disk would leave its second ask not knowing to look.
    if (asked.isPress) await ports.flush();
    const saved = await provider.saveDraft(raw).catch(async (error: unknown) => {
      const held = await provider.findDraft(messageId).catch(() => undefined);
      if (!held) throw error;
      return held;
    });
    return { ...filed(saved, older), raw, addressing };
  };

  /** Notes a draft filed in place of the version before it, which its server now owes a discard. */
  const filed = (saved: MessageRef, older: MessageRef | undefined) => {
    bodies.filed(saved);
    const replacing = older && !sameRef(older, saved) ? older : undefined;
    if (replacing) {
      // The member waits only for the new version. The old one is owed a discard before anything
      // else is awaited, and the next wake makes it before its sync, and lets its bytes go, so the
      // cache keeps only the newest draft's.
      replaced.owe(replacing);
      bodies.replaced(replacing);
      ports.outbox.release(replacing);
    }
    return { saved, ...(replacing ? { replacing } : {}) };
  };

  /** Keeps a filed draft's bytes for the composer, and owes the sync that folds it in. */
  const keep = async ({ saved, raw, replacing }: FiledDraft): Promise<void> => {
    // The composer reads the draft back at once, and the server's copy would wait behind the sync
    // this save owes. Once the draft is filed, a failure here costs only that wait, so it never
    // fails the save, which a retry would file again. A copy found rather than filed was written
    // by an ask before, so only the server's bytes are its own.
    if (raw) await bodies.keep(saved, raw).catch(report);
    // A discard owes its folder's sync, so no sync this save asks for finds both versions.
    await ports.owe(() => {
      if (replacing?.path !== saved.path) {
        ports.sync.folder({ account: saved.account, path: saved.path });
      }
    });
  };

  /** A draft as its own bytes say, before sync has it. */
  const parsed = async (draft: MessageRef) => {
    const bytes = await bodies.bytes(draft);
    if (!bytes) throw new Error('That draft is gone.');
    const read = await PostalMime.parse(bytes);
    const addresses = (list: PostalAddress[] | undefined) =>
      (list ?? [])
        .flatMap((entry) => entry.group ?? [entry])
        .flatMap(({ name, address }) =>
          address ? [{ ...(name ? { name } : {}), email: address }] : [],
        );
    return {
      messageId: messageIdOf(read.messageId),
      to: addresses(read.to),
      cc: addresses(read.cc),
      subject: read.subject ?? '',
    };
  };

  /**
   * What a draft answers, by its own In-Reply-To and References, as a parent to thread a save to.
   * Nothing for a message that isn't in Drafts, which no save replaces, or a draft that answers
   * nothing. A draft that can't be read any more leaves its threading behind, never the save.
   */
  const answeredBy = async (
    draft: MessageRef,
  ): Promise<Pick<Envelope, 'messageId' | 'references'> | undefined> => {
    const drafts = store.withRole(draft.account, 'drafts');
    if (draft.path !== drafts?.path) return undefined;
    const bytes = await bodies.bytes(draft).catch(() => null);
    if (!bytes) return undefined;
    const { references, inReplyTo } = await PostalMime.parse(bytes);
    const thread = referencesOf(references, inReplyTo);
    const parent = thread.at(-1);
    return parent === undefined
      ? undefined
      : { messageId: parent, references: thread.slice(0, -1) };
  };

  return {
    file,
    keep,

    /**
     * Writes a draft as mail and files it in the account's Drafts, where it replaces the version
     * before it. An attachment that travelled before is read from the message that holds it. A
     * draft is its own authority on what it answers: one that names no parent the index holds, as a
     * draft another client wrote may not, or whose parent went since the last save, keeps the
     * threading of the draft it replaces. Only a first save refuses a parent that has gone.
     *
     * `id` names the save, and the page asks again under it until the Mailroom answers, saying so
     * with `isAgain`, since an ask whose answer was lost may have filed it. An ask again while that
     * save is still being filed answers as it does, and one after looks for its copy first.
     */
    save(
      draft: DraftUpload,
      replaces: MessageRef | undefined,
      id: string,
      isAgain: boolean,
    ): Promise<MessageRef> {
      const asked = saving.get(id);
      if (asked) return asked;
      const filing = (async () => {
        const done = await file(draft, replaces, { id, mayBeFiled: isAgain, isPress: false });
        await keep(done);
        return done.saved;
      })().finally(() => saving.delete(id));
      saving.set(id, filing);
      return filing;
    },

    /**
     * Who a draft is to and what it's about, as its send keeps them, and its Message-ID, which the
     * send needs to find its copy in Sent. From the index, or from the draft itself before sync has
     * it.
     */
    async addressing(draft: MessageRef): Promise<Addressing> {
      const found = store.reads.message(draft) ?? (await parsed(draft));
      if (!found.messageId)
        throw new Error('That draft has no Message-ID, so it can’t be sent safely.');
      return {
        messageId: found.messageId,
        to: [...found.to, ...found.cc],
        subject: found.subject,
      };
    },

    /**
     * Discards the drafts newer versions replaced, longest owed first, and owes each one's folder
     * the sync its save left to this. An account whose server fails keeps its others owed for the
     * next check, rather than each waiting out the same server. Returns the accounts whose servers
     * failed.
     */
    async discardReplaced(): Promise<Set<AccountId>> {
      const failing = new Set<AccountId>();
      for (const draft of replaced.owed()) {
        if (!failing.has(draft.account)) {
          try {
            await (await ports.provider(draft.account)).discardDraft(draft);
            replaced.discarded(draft);
          } catch (error) {
            report(error);
            failing.add(draft.account);
          }
        }
        ports.sync.folder({ account: draft.account, path: draft.path });
      }
      return failing;
    },

    /** Whether a draft is still owed a discard on an account whose server didn't just fail. */
    owesDiscards(failing: ReadonlySet<AccountId>): boolean {
      return replaced.owed().some(({ account }) => !failing.has(account));
    },

    /** Forgets what an account's server owes, as removing the account does. */
    forget(account: AccountId) {
      replaced.forget(account);
    },
  };
}

/**
 * The Message-ID of a save asked under `id`, made from it so that asking again names the same
 * message. An id may be any text, so it is hashed into what a Message-ID can hold.
 */
async function messageIdFor(id: string, domain: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(id));
  const hex = [...new Uint8Array(digest).slice(0, 16)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  return `<${hex}@${domain}>`;
}
