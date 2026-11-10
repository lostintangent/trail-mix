import type { AccountId, ConversationId, Envelope, FolderRef, FolderRole } from './model.ts';

/**
 * Conversation linking. A conversation is the messages of one account that reply to each other,
 * connected through their Message-ID, In-Reply-To and References headers. It gathers from the
 * account's Inbox, Sent, Archive and Drafts together, so a reply being written sits in its
 * conversation. A message in any other folder, such as Trash, Junk or one the member made, links
 * only with messages in that same folder.
 *
 * Which messages share a conversation depends only on which messages there are, never on the order
 * they arrived in, and so does the conversation's id. A rebuilt index gives the same conversations.
 */

/** The folders whose messages gather into one conversation. */
const GATHERED_ROLES: ReadonlySet<FolderRole> = new Set(['inbox', 'sent', 'archive', 'drafts']);

/** How many References a message keeps: the thread's first message and its nearest ancestors. */
const MAX_REFERENCES = 20;

/**
 * Where a message's conversation gathers from: `''` for its account's Inbox, Sent, Archive and
 * Drafts, or else the path of its own folder.
 */
export function gatheringOf(folder: FolderRef, role: FolderRole | undefined): string {
  return role && GATHERED_ROLES.has(role) ? '' : folder.path;
}

/**
 * Gathers messages of one account and one gathering into conversations, and returns the id of each
 * message's conversation in the order given. Two messages share a conversation when a chain of
 * Message-IDs connects them, including ids of messages the index does not hold.
 */
export function linkConversations(
  account: AccountId,
  gathering: string,
  envelopes: readonly Envelope[],
): ConversationId[] {
  const parent = envelopes.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) i = parent[i] = parent[parent[i]!]!;
    return i;
  };

  const holder = new Map<string, number>();
  envelopes.forEach((envelope, i) => {
    for (const id of linkIdsOf(envelope)) {
      const other = holder.get(id);
      if (other === undefined) holder.set(id, i);
      else parent[find(i)] = find(other);
    }
  });

  const roots = new Map<number, string>();
  envelopes.forEach((envelope, i) => {
    const group = find(i);
    const root = rootOf(envelope);
    const current = roots.get(group);
    if (current === undefined || root < current) roots.set(group, root);
  });
  return envelopes.map((_, i) => conversationIdOf(account, gathering, roots.get(find(i))!));
}

/** The ids a message links through: its references, then its own Message-ID. */
export function linkIdsOf(envelope: Envelope): string[] {
  return [...new Set([...envelope.references, envelope.messageId].filter(Boolean))];
}

/**
 * The id a message would name its conversation by: the thread's first message as its References
 * report it, or else its own Message-ID. A message with neither stands alone, under its own ref.
 */
export function rootOf(envelope: Envelope): string {
  return linkIdsOf(envelope)[0] ?? `#${envelope.uidValidity}/${envelope.uid}/${envelope.path}`;
}

/**
 * A conversation is named by its account, its gathering and the smallest root among its messages.
 * Each part is URI-encoded, so `:` separates them unambiguously and the id is safe in a URL.
 */
export function conversationIdOf(
  account: AccountId,
  gathering: string,
  root: string,
): ConversationId {
  return [account, gathering, root].map(encodeURIComponent).join(':');
}

/** The parts of a conversation id, or nothing when it is not one this module made. */
export function partsOf(
  id: ConversationId,
): { account: AccountId; gathering: string; root: string } | undefined {
  const parts = id.split(':');
  if (parts.length !== 3) return undefined;
  const [account, gathering, root] = parts.map(decodeURIComponent) as [string, string, string];
  return { account, gathering, root };
}

/** The Message-ID a message names itself by, in `<id@host>` form, or `''` when it has none. */
export function messageIdOf(header: string | undefined): string {
  const [id] = idsIn(header ?? '');
  if (id) return id;
  // A few mailers leave off the angle brackets. The header holds only the id, so it is unambiguous.
  const bare = header?.trim() ?? '';
  return bare && !/[\s<>()"]/.test(bare) ? `<${bare}>` : '';
}

/**
 * The ids a message replies to, the thread's first message first, from its References and
 * In-Reply-To headers. In-Reply-To counts only for its first id, the parent, and only when
 * References leaves it out. Duplicates are dropped, and a long chain keeps its first id and its
 * nearest ancestors, so a hostile header cannot merge thousands of conversations.
 */
export function referencesOf(
  references: string | undefined,
  inReplyTo: string | undefined,
): string[] {
  const ids = [...new Set(idsIn(references ?? ''))];
  const [parent] = idsIn(inReplyTo ?? '');
  if (parent && !ids.includes(parent)) ids.push(parent);
  return ids.length > MAX_REFERENCES
    ? [ids[0]!, ...ids.slice(ids.length - MAX_REFERENCES + 1)]
    : ids;
}

/**
 * Every `<id>` in a header, in order. Comments and quoted text are skipped, so an address inside
 * `(message from "Ada <ada@example.com>")` is not taken for an id, and whitespace that folding left
 * inside an id is removed.
 */
function idsIn(header: string): string[] {
  const ids: string[] = [];
  let id: string | undefined;
  let comment = 0;
  let quoted = false;
  for (let i = 0; i < header.length; i++) {
    const char = header[i]!;
    if (id !== undefined) {
      if (char === '>') {
        if (id) ids.push(`<${id}>`);
        id = undefined;
      } else if (char === '<') id = '';
      else if (!/\s/.test(char)) id += char;
    } else if (comment || quoted) {
      if (char === '\\') i++;
      else if (quoted) quoted = char !== '"';
      else if (char === '(') comment++;
      else if (char === ')') comment--;
    } else if (char === '<') id = '';
    else if (char === '(') comment = 1;
    else if (char === '"') quoted = true;
  }
  return ids;
}
