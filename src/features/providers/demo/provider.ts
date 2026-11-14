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
import { previewFrom } from '../imap/core/preview.ts';
import { withoutBcc } from '../imap/core/send.ts';
import { planSync } from '../imap/core/sync.ts';
import {
  SEARCH_LIMIT,
  SendFailure,
  beforeSending,
  type MailProvider,
  type Moved,
} from '../provider.ts';
import * as server from './mailbox.ts';
import { BUSY_FOLDER, BUSY_LIST, DEMO_ACCOUNTS, UNREACHABLE, type DemoKind } from './stories.ts';

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
  /** Lets a moment pass, in which a host that files its own copy in Sent files what it accepted. */
  settle(): Promise<void>;
  /**
   * Turns the host's own copies in Sent off, as a Zoho member can, or on again. The provider still
   * waits for them, as it does for a host whose member turned them off.
   */
  fileSentCopies(on: boolean): void;
  /** Removes every message, and every folder the mailbox did not start with, and every copy owed. */
  empty(): Promise<void>;
  /**
   * Answers a one-click unsubscribe posted to `address` as the demo's list servers do, with no
   * network: each takes it, but the shop's turns its first try away.
   */
  unsubscribe(address: string): Promise<Response>;
};

export { DEMO_ACCOUNTS, type DemoKind };
export { demoMailbox, type DemoMailbox } from './mailbox.ts';

/**
 * `filesSent` makes the host file its own copy of what it accepts in Sent, as Zoho's and Outlook's
 * do, a moment later: once `settle` lets a moment pass, or by the provider's next look for it. The
 * provider leaves Sent to the host while it waits.
 */
export function demoServer(
  account: AccountId,
  initial: server.DemoMailbox,
  save: (mailbox: server.DemoMailbox) => void | Promise<void>,
  { filesSent = false }: { filesSent?: boolean } = {},
): DemoServer {
  let mailbox = initial;
  const watchers = new Map<string, Set<() => void>>();
  /** What a host that files its own copy in Sent has accepted and not yet filed. */
  const unfiled: server.Written[] = [];
  /** The Message-IDs the provider has looked for in Sent and not found, while waiting for the host. */
  const looked = new Set<string>();
  let hostFiles = filesSent;

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

  /** What a provider reports of the message at a UID, as sync and search both report it. */
  function envelopeAt(path: string, uid: number): Envelope | undefined {
    const message = server.messageAt(mailbox, path, uid);
    return message && { ...refOf(path, uid), ...message.content(), flags: message.flags };
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
    if (!messageId) return undefined;
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
            delimiter: '/',
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
        const envelopes = plan.envelopes.flatMap((uid) => envelopeAt(path, uid) ?? []);
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
      const moved: Moved[] = [];
      for (const [path, uids] of live(refs)) {
        const from = server.folderOf(next, path)!.uidValidity;
        const [after, pairs] = server.move(next, path, uids, to);
        next = after;
        const landedIn = server.folderOf(next, to)!.uidValidity;
        for (const [was, uid] of pairs) {
          moved.push({
            from: { account, path, uidValidity: from, uid: was },
            to: { account, path: to, uidValidity: landedIn, uid },
          });
        }
      }
      await commit(next, [...live(refs).keys(), to]);
      return moved;
    },

    async saveDraft(message) {
      const draft = await written(message);
      const drafts = roleFolder('drafts');
      const [next, filed] = server.append(mailbox, drafts, draft, DRAFT);
      await commit(next, [drafts]);
      return refOf(drafts, filed);
    },

    findDraft: (messageId) =>
      settle(() => {
        const drafts = roleFolder('drafts');
        const uid = messageIdIn(drafts, messageId);
        return uid === undefined ? undefined : refOf(drafts, uid);
      }),

    async discardDraft(draft) {
      const drafts = roleFolder('drafts');
      // Only a draft is ever discarded, so a ref to anything else cannot cost a message.
      const gone = live([draft]).get(drafts);
      if (!gone) return;
      await commit(server.expunge(mailbox, drafts, gone), [drafts]);
    },

    submit: (draft, messageId) =>
      beforeSending(async () => {
        if (messageIdIn(roleFolder('sent'), messageId) !== undefined) return 'sent' as const;
        const found = find(draft);
        if (!found) return 'missing' as const;
        const raw = bytesOf(found.message.raw());
        const outgoing = await written(withoutBcc(raw));
        const recipients = await recipientsOf(raw);
        // The host turns a message to the unreachable domain away once, and takes its next try.
        const refused = mailbox.refused ?? [];
        if (
          recipients.some((email) => email.endsWith(`@${UNREACHABLE}`)) &&
          !refused.includes(messageId)
        ) {
          await commit({ ...mailbox, refused: [...refused, messageId] }, []);
          throw new SendFailure(
            `The mail server refused it: 554 5.4.4 ${UNREACHABLE} can’t be reached right now`,
            false,
          );
        }
        await commit(accepted(mailbox, outgoing, recipients), ['INBOX']);
        return 'sent' as const;
      }),

    file: (draft, messageId, waitForHost) =>
      beforeSending(async () => {
        const found = find(draft);
        if (!found) return 'filed' as const;
        const sent = roleFolder('sent');
        const inSent = () => messageIdIn(sent, messageId) !== undefined;
        if (!inSent() && filesSent && waitForHost) {
          if (looked.has(messageId)) {
            await fileHostCopies((copy) => copy.content.messageId === messageId);
          } else {
            looked.add(messageId);
          }
          if (!inSent()) return 'unfiled' as const;
        }
        const copy = inSent() ? undefined : await written(withoutBcc(bytesOf(found.message.raw())));
        // The draft may have changed while its copy was read, so it is found again.
        const still = find(draft);
        if (!still) return 'filed' as const;
        let next = mailbox;
        if (copy && !inSent()) [next] = server.append(next, sent, copy, SENT);
        await commit(server.expunge(next, still.path, [still.uid]), [still.path, sent]);
        looked.delete(messageId);
        return 'filed' as const;
      }),

    search: (path, text) =>
      settle(() => {
        const needle = text.toLowerCase();
        const found = server.uidsIn(mailbox, path).filter((uid) => {
          const message = server.messageAt(mailbox, path, uid)!;
          const { subject, from, to, cc } = message.content();
          const people = [from, ...to, ...cc].map(({ name, email }) => `${name ?? ''} ${email}`);
          return [subject, ...people, message.text()].join('\n').toLowerCase().includes(needle);
        });
        return found
          .sort((a, b) => b - a)
          .slice(0, SEARCH_LIMIT)
          .flatMap((uid) => envelopeAt(path, uid) ?? [])
          .sort((a, b) => b.date.localeCompare(a.date) || b.uid - a.uid);
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
      // The server turns the first delete of the seeded Projects away, as if another session had
      // it open, and takes the next.
      const refused = mailbox.refused ?? [];
      const asked = `DELETE ${path}`;
      if (path === BUSY_FOLDER && server.folderOf(mailbox, path) && !refused.includes(asked)) {
        await commit({ ...mailbox, refused: [...refused, asked] }, []);
        throw new Error(`NO [INUSE] ${path} is open in another session`);
      }
      await commit(server.deleteFolder(mailbox, path), [...watchers.keys()]);
    },

    close: () => settle(() => watchers.clear()),
  };

  /** Files in Sent the host's own copies that `which` picks, of those it owes. */
  async function fileHostCopies(which: (copy: server.Written) => boolean) {
    const sent = server.folderWithRole(mailbox, 'sent');
    let next = mailbox;
    for (const copy of unfiled.filter(which)) {
      unfiled.splice(unfiled.indexOf(copy), 1);
      if (sent) [next] = server.append(next, sent.path, copy, SENT);
    }
    await commit(next, sent ? [sent.path] : []);
  }

  /**
   * What the host does with a message it accepted: delivers it to each recipient, and later files a
   * copy in Sent if it files its own. The only recipient this server holds mail for is the account
   * itself, so mail to yourself arrives.
   */
  function accepted(
    current: server.DemoMailbox,
    message: server.Written,
    recipients: readonly string[],
  ): server.DemoMailbox {
    if (hostFiles) unfiled.push(message);
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
      await commit(accepted(mailbox, message, await recipientsOf(raw)), ['INBOX']);
    },
    settle: () => fileHostCopies(() => true),
    fileSentCopies(on) {
      hostFiles = on;
    },
    async empty() {
      unfiled.length = 0;
      looked.clear();
      await commit(server.emptied(mailbox), [...watchers.keys()]);
    },
    async unsubscribe(address) {
      const refused = mailbox.refused ?? [];
      const asked = `UNSUBSCRIBE ${address}`;
      if (address === BUSY_LIST && !refused.includes(asked)) {
        await commit({ ...mailbox, refused: [...refused, asked] }, []);
        return new Response(null, { status: 503, statusText: 'Service Unavailable' });
      }
      return new Response(null, { status: 200 });
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
      // What a member writes, as a draft or a copy in Sent, no server has vouched for.
      verified: false,
      preview: previewFrom({
        ...(parsed.text === undefined ? {} : { plain: text }),
        ...(parsed.html === undefined ? {} : { html: parsed.html }),
      }),
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
