import PostalMime, { type Address as ParsedAddress } from 'postal-mime';
import {
  messageIdOf,
  referencesOf,
  type AccountId,
  type Address,
  type Envelope,
  type Flags,
  type Folder,
  type MessageRef,
} from '../../mail/core/index.ts';
import { previewOf } from '../imap/core/envelope.ts';
import { planSync } from '../imap/core/sync.ts';
import type { MailProvider } from '../provider.ts';
import * as server from './mailbox.ts';
import { DEMO_ACCOUNTS, type DemoKind } from './stories.ts';

/**
 * The demo provider: a MailProvider over the demo mailbox, for tests, agents, previews and the
 * public demo. It keeps the mailbox as a value, hands every change to `save` so the Mailroom can
 * keep it, and syncs through the same reconciliation as IMAP, since the mailbox numbers its
 * messages as an IMAP server does.
 *
 * The rest of the server is the world the provider meets: mail arriving, another client, the host
 * accepting mail. The contract suite plays it, and the public demo can too.
 */
export type DemoServer = {
  provider: MailProvider;
  /** Files a message in a folder, the Inbox unless named, as mail arriving from outside does. */
  deliver(raw: Uint8Array, folder?: string): Promise<MessageRef>;
  /** Removes a message by its Message-ID, as another client would. */
  expunge(folder: string, messageId: string): Promise<void>;
  /** Numbers a folder's messages again under a new UIDVALIDITY, as a server that lost its state does. */
  resetUidValidity(folder: string): Promise<void>;
  /** Has the host accept a message for delivery, without the provider. */
  submit(raw: Uint8Array): Promise<void>;
  /** Removes every message, and every folder the mailbox did not start with. */
  empty(): Promise<void>;
};

export { DEMO_ACCOUNTS, type DemoKind };
export { demoMailbox, type DemoMailbox } from './mailbox.ts';

export function demoServer(
  account: AccountId,
  initial: server.DemoMailbox,
  save: (mailbox: server.DemoMailbox) => void | Promise<void>,
): DemoServer {
  let mailbox = initial;
  const watchers = new Map<string, Set<() => void>>();

  /** Makes the next mailbox the current one, keeps it, and tells whoever watches what changed. */
  async function commit(next: server.DemoMailbox, changed: readonly string[]) {
    if (next === mailbox) return;
    mailbox = next;
    await save(next);
    for (const path of new Set(changed)) for (const watcher of watchers.get(path) ?? []) watcher();
  }

  /** Whether a ref still names one of this account's folders at its current UIDVALIDITY. */
  function current(ref: MessageRef): boolean {
    return (
      ref.account === account && server.folderOf(mailbox, ref.path)?.uidValidity === ref.uidValidity
    );
  }

  /** The UIDs of the refs that are still current, by folder. */
  function live(refs: readonly MessageRef[]): Map<string, number[]> {
    const byFolder = Map.groupBy(refs.filter(current), (ref) => ref.path);
    return new Map([...byFolder].map(([path, inFolder]) => [path, inFolder.map(({ uid }) => uid)]));
  }

  /** The message a ref names, while it is still where the ref says. */
  function find(ref: MessageRef) {
    const message = current(ref) ? server.messageAt(mailbox, ref.path, ref.uid) : undefined;
    return message && { path: ref.path, uid: ref.uid, message };
  }

  function refOf(path: string, uid: number): MessageRef {
    return { account, path, uidValidity: server.folderOf(mailbox, path)!.uidValidity, uid };
  }

  function roleFolder(role: 'drafts' | 'sent'): string {
    const folder = server.folderWithRole(mailbox, role);
    if (!folder) throw new Error(`This mailbox has no ${role} folder.`);
    return folder.path;
  }

  function messageIdIn(path: string, messageId: string): number | undefined {
    return server
      .uidsIn(mailbox, path)
      .find((uid) => server.messageAt(mailbox, path, uid)!.content().messageId === messageId);
  }

  const provider: MailProvider = {
    folders: () =>
      settle(() =>
        mailbox.folders.map(({ path, role }): Folder => {
          const parent = path.slice(0, Math.max(0, path.lastIndexOf('/')));
          return {
            account,
            path,
            name: path.slice(path.lastIndexOf('/') + 1),
            ...(server.folderOf(mailbox, parent) ? { parent } : {}),
            ...(role ? { role } : {}),
            ...server.countsOf(mailbox, path),
          };
        }),
      ),

    sync: (path, cursor, window) =>
      settle(() => {
        const folder = server.folderOf(mailbox, path);
        if (!folder) throw new Error(`There is no folder "${path}".`);
        const inWindow = server.uidsSince(mailbox, path, window.since);
        const plan = planSync({ account, path }, cursor, {
          uidValidity: folder.uidValidity,
          uidNext: folder.uidNext,
          highestModSeq: BigInt(folder.modSeq),
          inWindow,
        });
        const envelopes = plan.envelopes.flatMap((uid): Envelope[] => {
          const message = server.messageAt(mailbox, path, uid);
          return message
            ? [{ ...refOf(path, uid), ...message.content(), flags: message.flags }]
            : [];
        });
        const flags =
          plan.flags === 'none'
            ? undefined
            : plan.flags === 'all'
              ? new Map(inWindow.map((uid) => [uid, server.messageAt(mailbox, path, uid)!.flags]))
              : server.flagsChangedSince(mailbox, path, Number(plan.flags.changedSince));
        return plan.reconcile({ envelopes, ...(flags ? { flags } : {}) });
      }),

    body: (ref) =>
      settle(() => {
        const found = find(ref);
        if (!found) throw new Error('The message is no longer on the server.');
        return new Blob([bytesOf(found.message.raw())]).stream();
      }),

    async setFlags(refs, change) {
      let next = mailbox;
      for (const [path, uids] of live(refs)) next = server.setFlags(next, path, uids, change);
      await commit(next, [...live(refs).keys()]);
    },

    async move(refs, to) {
      let next = mailbox;
      for (const [path, uids] of live(refs)) next = server.move(next, path, uids, to);
      await commit(next, [...live(refs).keys(), to]);
    },

    async saveDraft(message, replaces) {
      const draft = await written(message);
      const drafts = roleFolder('drafts');
      // Saving the same draft again finds the copy the first save filed.
      let uid = server.uidsIn(mailbox, drafts).find((candidate) => {
        const saved = server.messageAt(mailbox, drafts, candidate)!;
        return saved.content().messageId === draft.content.messageId && saved.raw() === draft.raw;
      });
      let next = mailbox;
      if (uid === undefined) {
        [next, uid] = server.append(next, drafts, draft, DRAFT);
      }
      // Only a draft is ever replaced, so a ref to anything else cannot cost a message.
      const older = live(replaces ? [replaces] : []).get(drafts) ?? [];
      next = server.expunge(
        next,
        drafts,
        older.filter((old) => old !== uid),
      );
      await commit(next, [drafts]);
      return refOf(drafts, uid);
    },

    async send(draft) {
      const found = find(draft);
      if (!found) return;
      const { messageId } = found.message.content();
      const raw = bytesOf(found.message.raw());
      const sent = roleFolder('sent');
      const filed = messageId ? messageIdIn(sent, messageId) !== undefined : false;
      const outgoing = filed ? undefined : await written(withoutBcc(raw));
      const recipients = filed ? [] : await recipientsOf(raw);
      // The draft may have changed while the message was read, so it is found again.
      const still = find(draft);
      if (!still) return;
      let next = mailbox;
      if (outgoing) {
        next = submitted(next, outgoing, recipients);
        [next] = server.append(next, sent, outgoing, SENT);
      }
      await commit(server.expunge(next, still.path, [still.uid]), [still.path, sent, 'INBOX']);
    },

    search: (path, text) =>
      settle(() => {
        const needle = text.toLowerCase();
        return server.uidsIn(mailbox, path).filter((uid) => {
          const message = server.messageAt(mailbox, path, uid)!;
          const { subject, from, to, cc } = message.content();
          const people = [from, ...to, ...cc].map(({ name, email }) => `${name ?? ''} ${email}`);
          return [subject, ...people, message.text()].join('\n').toLowerCase().includes(needle);
        });
      }),

    watch(path, onChange) {
      const watching = watchers.get(path) ?? new Set();
      watching.add(onChange);
      watchers.set(path, watching);
      return () => watching.delete(onChange);
    },

    async createFolder(path) {
      await commit(server.createFolder(mailbox, path), [...watchers.keys()]);
    },

    async renameFolder(path, to) {
      await commit(server.renameFolder(mailbox, path, to), [...watchers.keys()]);
    },

    async deleteFolder(path) {
      await commit(server.deleteFolder(mailbox, path), [...watchers.keys()]);
    },

    close: () => settle(() => watchers.clear()),
  };

  /**
   * What the host does with a message it accepted: delivers it to each recipient. The only one
   * this server holds mail for is the account itself, so mail to yourself arrives.
   */
  function submitted(
    current: server.DemoMailbox,
    message: server.Written,
    recipients: readonly string[],
  ): server.DemoMailbox {
    const me = DEMO_ACCOUNTS[current.kind].me.email;
    return recipients.includes(me) ? server.append(current, 'INBOX', message, NEW)[0] : current;
  }

  return {
    provider,
    async deliver(raw, folder = 'INBOX') {
      const [next, uid] = server.append(mailbox, folder, await written(raw), NEW);
      await commit(next, [folder]);
      return refOf(folder, uid);
    },
    async expunge(folder, messageId) {
      const uid = messageIdIn(folder, messageId);
      if (uid !== undefined) await commit(server.expunge(mailbox, folder, [uid]), [folder]);
    },
    async resetUidValidity(folder) {
      await commit(server.renumber(mailbox, folder), [folder]);
    },
    async submit(raw) {
      const message = await written(withoutBcc(raw));
      await commit(submitted(mailbox, message, await recipientsOf(raw)), ['INBOX']);
    },
    async empty() {
      await commit(server.emptied(mailbox), [...watchers.keys()]);
    },
  };
}

/** Runs a step that needs no waiting as a promise, so what it throws rejects the promise. */
function settle<T>(step: () => T): Promise<T> {
  return new Promise((resolve) => resolve(step()));
}

const NEW: Flags = { seen: false, flagged: false, answered: false, draft: false };
const SENT: Flags = { ...NEW, seen: true };
const DRAFT: Flags = { ...SENT, draft: true };

/** What a message from outside the seed says, read with the parser that reads every body. */
async function written(bytes: Uint8Array): Promise<server.Written> {
  const parsed = await PostalMime.parse(bytes);
  const text = parsed.text ?? '';
  const date = parsed.date && !Number.isNaN(Date.parse(parsed.date)) ? parsed.date : undefined;
  const listId = parsed.headers.find((header) => header.key === 'list-id')?.value;
  const unsubscribe = parsed.headers.find((header) => header.key === 'list-unsubscribe')?.value;
  return {
    raw: binary(bytes),
    text,
    content: {
      messageId: messageIdOf(parsed.messageId),
      references: referencesOf(parsed.references, parsed.inReplyTo),
      from: addresses(parsed.from ? [parsed.from] : [])[0] ?? { email: '' },
      to: addresses(parsed.to ?? []),
      cc: addresses(parsed.cc ?? []),
      subject: parsed.subject ?? '',
      date: new Date(date ?? Date.now()).toISOString().replace(/\.\d{3}Z$/, '.000Z'),
      preview:
        parsed.text === undefined ? previewOf(parsed.html ?? '', true) : previewOf(text, false),
      // As IMAP's providers judge it: a file marked as one, or anything but an inline image.
      hasAttachments: parsed.attachments.some(
        (file) =>
          file.disposition === 'attachment' ||
          !(file.mimeType.startsWith('image/') && file.contentId),
      ),
      ...(listId
        ? {
            list: {
              id: /<([^>]*)>/.exec(listId)?.[1] ?? listId,
              ...(unsubscribe ? { unsubscribe } : {}),
            },
          }
        : {}),
    },
  };
}

/** Everyone a message is addressed to, Bcc included, lowercased. */
async function recipientsOf(bytes: Uint8Array): Promise<string[]> {
  const parsed = await PostalMime.parse(bytes);
  return addresses([...(parsed.to ?? []), ...(parsed.cc ?? []), ...(parsed.bcc ?? [])]).map(
    ({ email }) => email.toLowerCase(),
  );
}

/** The message without its Bcc header, which no recipient and no copy in Sent may carry. */
function withoutBcc(bytes: Uint8Array): Uint8Array {
  const raw = binary(bytes);
  const end = raw.search(/\r?\n\r?\n/);
  const head = end < 0 ? raw : raw.slice(0, end);
  let dropping = false;
  const kept = head.split(/\r?\n/).filter((line) => {
    if (/^[ \t]/.test(line)) return !dropping;
    dropping = /^bcc:/i.test(line);
    return !dropping;
  });
  return bytesOf(kept.join('\r\n') + raw.slice(head.length));
}

function addresses(parsed: readonly ParsedAddress[]): Address[] {
  return parsed
    .flatMap((address) => address.group ?? [address])
    .map(({ name, address }) => ({ ...(name ? { name } : {}), email: address ?? '' }));
}

/** Raw messages are kept as strings of one character per byte, so they survive a round trip. */
function binary(bytes: Uint8Array): string {
  let text = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return text;
}

function bytesOf(raw: string): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}
