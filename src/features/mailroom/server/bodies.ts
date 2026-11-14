import PostalMime from 'postal-mime';
import {
  oneClickUnsubscribe,
  refKey,
  type AccountId,
  type Body,
  type MessageRef,
  type MimeAttachment,
} from '../../mail/core/index.ts';
import type { MailProvider } from '../../providers/index.ts';
import type { EnvelopeIndex } from './envelope-index.ts';
import type { Sql } from './schema.ts';
import { headerOf } from './unsubscribe.ts';

/**
 * The Body cache: each message's raw bytes in the bucket, under the member's own prefix, fetched
 * from its server the first time they're asked for and kept while the index holds the message. A
 * draft this Mailroom saved is kept as it wrote it. A body whose message leaves the index, or that
 * the index never held, goes at a later wake.
 */
export type BodyCache = ReturnType<typeof bodyCache>;

/** How many cached bodies one wake lets go or lists, in batches as large as a bucket takes. */
export type BodyBatches = { wake: number; delete: number };

const BODIES_LET_GO: BodyBatches = { wake: 10_000, delete: 1_000 };

export function bodyCache(ports: {
  bucket: R2Bucket;
  member: string;
  sql: Sql;
  store: EnvelopeIndex;
  provider: (account: AccountId) => Promise<MailProvider>;
  /** Whether a message is the index's or the last full-text search found it, so it may be fetched. */
  isKnown: (ref: MessageRef) => boolean;
  /** The names whose Authentication-Results an account's mail is verified by. */
  signersOf: (account: AccountId) => readonly string[];
}) {
  const { bucket, member, sql, store } = ports;
  /** Drafts this Mailroom filed, whose attachments the next version may carry before sync sees it. */
  const drafts = new Set<string>();

  const keyOf = (ref: MessageRef) =>
    `${member}/${ref.account}/${encodeURIComponent(ref.path)}/${ref.uidValidity}/${ref.uid}`;

  /** The message a key in the cache keeps the body of, or nothing for a key of another shape. */
  const refOf = (key: string): MessageRef | undefined => {
    const prefix = `${member}/`;
    if (!key.startsWith(prefix)) return undefined;
    const [account, path, uidValidity = '', uid = '', ...more] = key
      .slice(prefix.length)
      .split('/');
    const isNumber = (part: string) => /^\d+$/.test(part);
    if (!account || path === undefined || more.length || !isNumber(uidValidity) || !isNumber(uid))
      return undefined;
    try {
      return {
        account,
        path: decodeURIComponent(path),
        uidValidity: Number(uidValidity),
        uid: Number(uid),
      };
    } catch {
      // Not a path `encodeURIComponent` wrote.
      return undefined;
    }
  };

  /** A message's raw bytes: from the cache, or from the server once and kept from then on. */
  const bytes = async (ref: MessageRef): Promise<Uint8Array<ArrayBuffer> | null> => {
    const key = keyOf(ref);
    const cached = await bucket.get(key);
    if (cached) return new Uint8Array(await cached.arrayBuffer());
    if (!ports.isKnown(ref) && !drafts.has(refKey(ref))) return null;
    const stream = await (await ports.provider(ref.account)).body(ref);
    const fetched = new Uint8Array(await new Response(stream).arrayBuffer());
    await bucket.put(key, fetched);
    // A draft just saved is indexed by the sync its save owes.
    if (!store.reads.message(ref) && !drafts.has(refKey(ref))) store.oweBody(ref);
    return fetched;
  };

  /** One attachment of a message, by its place among them, as `Body.attachments` numbers them. */
  const attachment = async (ref: MessageRef, index: number) => {
    const held = await bytes(ref);
    return held && attachmentOf(held, index);
  };

  return {
    bytes,
    attachment,

    /** A message's body as the reader shows it, with the one-click unsubscribe it offers. */
    async read(ref: MessageRef): Promise<Body> {
      const held = await bytes(ref);
      if (!held) throw new Error('That message is no longer in this mailbox.');
      const parsed = await PostalMime.parse(held);
      const unsubscribe = oneClickUnsubscribe(headerOf(held), ports.signersOf(ref.account));
      return {
        ...(parsed.html === undefined ? {} : { html: parsed.html }),
        ...(parsed.text === undefined ? {} : { text: parsed.text }),
        attachments: parsed.attachments.map((each, index) => ({
          id: String(index),
          name: each.filename ?? `Attachment ${index + 1}`,
          type: each.mimeType,
          size: sizeOf(each.content),
          ...(each.contentId ? { contentId: each.contentId.replace(/^<|>$/g, '') } : {}),
        })),
        headers: parsed.headers.map((header) => [header.originalKey, header.value]),
        ...(unsubscribe ? { unsubscribe } : {}),
      };
    },

    /** A message's raw bytes, for the Worker's route. Null means the message is gone. */
    async source(ref: MessageRef): Promise<ReadableStream<Uint8Array> | null> {
      const held = await bytes(ref);
      return held && new Blob([held]).stream();
    },

    /** One attachment's bytes, for the Worker's route. Null means the message or part is gone. */
    async part(
      ref: MessageRef,
      id: string,
    ): Promise<{ body: ReadableStream<Uint8Array>; type: string; name: string } | null> {
      const raw = await bytes(ref);
      if (!raw || !/^\d{1,4}$/.test(String(id))) return null;
      const held = await attachmentOf(raw, Number(id));
      if (!held) return null;
      return {
        // The Workers runtime types a Blob's stream loosely, as ReadableStream<any>, so it's named here.
        body: new Blob([held.content]).stream() as ReadableStream<Uint8Array>,
        type: held.type,
        name: held.name,
      };
    },

    /** Keeps the bytes of a draft this Mailroom filed, as it wrote them. */
    async keep(ref: MessageRef, raw: Uint8Array) {
      await bucket.put(keyOf(ref), raw);
    },

    /** Notes a draft this Mailroom filed, which is kept before the index holds it. */
    filed(ref: MessageRef) {
      drafts.add(refKey(ref));
    },

    /** Lets a draft a newer version replaced go, so the cache keeps only the newest's bytes. */
    replaced(ref: MessageRef) {
      drafts.delete(refKey(ref));
      store.oweBody(ref);
    },

    /**
     * Deletes the cached bodies owed a delete, a bucket's batch at a time, and clears what was owed
     * once each batch is gone, so a wake that ends midway leaves the rest, and the batch it was
     * deleting, for the next. Returns whether more are owed than one wake lets go.
     */
    async letGo(): Promise<boolean> {
      for (let gone = 0; gone < BODIES_LET_GO.wake; gone += BODIES_LET_GO.delete) {
        const refs = store.owedBodies(BODIES_LET_GO.delete);
        if (refs.length === 0) return false;
        await bucket.delete(refs.map(keyOf));
        store.bodiesLetGo(refs);
      }
      return store.owedBodies(1).length > 0;
    },

    /**
     * Sweeps the cache once, as a version asks after a release that kept each body after its
     * message left: a page of the bucket at a time, it lets go every body whose message the index
     * doesn't hold, unless it is a draft just saved, and notes the last key it listed, so a wake cut
     * short or a restart goes on from there. Returns whether more is left than one wake lists.
     */
    async sweep(batches = BODIES_LET_GO): Promise<boolean> {
      for (let listed = 0; listed < batches.wake; listed += batches.delete) {
        const [sweep] = sql.all<{ after: string | null }>(`SELECT after FROM body_sweep`);
        if (!sweep) return false;
        const page = await bucket.list({
          prefix: `${member}/`,
          limit: batches.delete,
          ...(sweep.after === null ? {} : { startAfter: sweep.after }),
        });
        const strays = page.objects.flatMap(({ key }) => {
          const ref = refOf(key);
          const isKept = !ref || store.reads.message(ref) || drafts.has(refKey(ref));
          return isKept ? [] : [key];
        });
        if (strays.length) await bucket.delete(strays);
        const last = page.objects.at(-1)?.key;
        if (!page.truncated) sql.run(`DELETE FROM body_sweep`);
        else if (last) sql.run(`UPDATE body_sweep SET after = ?`, last);
      }
      return sql.all(`SELECT 1 FROM body_sweep`).length > 0;
    },

    /** Deletes every body under a prefix of the member's: one account's, or all of theirs. */
    async forget(prefix: string) {
      for (let cursor: string | undefined; ;) {
        const listed = await bucket.list({ prefix, ...(cursor ? { cursor } : {}) });
        if (listed.objects.length) await bucket.delete(listed.objects.map((o) => o.key));
        if (!listed.truncated) return;
        cursor = listed.cursor;
      }
    },
  };
}

/** One attachment of a raw message, by its place among them, as `Body.attachments` numbers them. */
async function attachmentOf(bytes: Uint8Array, index: number): Promise<MimeAttachment | undefined> {
  const attachment = (await PostalMime.parse(bytes)).attachments[index];
  if (!attachment) return undefined;
  const content =
    typeof attachment.content === 'string'
      ? new TextEncoder().encode(attachment.content)
      : new Uint8Array(attachment.content);
  return {
    name: attachment.filename ?? `Attachment ${index + 1}`,
    type: attachment.mimeType,
    content,
    ...(attachment.contentId ? { contentId: attachment.contentId.replace(/^<|>$/g, '') } : {}),
  };
}

const sizeOf = (content: ArrayBuffer | Uint8Array | string) =>
  typeof content === 'string' ? new TextEncoder().encode(content).length : content.byteLength;
