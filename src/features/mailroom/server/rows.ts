import {
  searchWords,
  type ConversationSummary,
  type FolderRef,
  type ListItem,
  type Message,
  type MessageRef,
} from '../../mail/core/index.ts';
import type { SqlValue } from './schema.ts';

/*
 * How the envelope index's tables hold what it keeps, which the fold writes and the lists read: a
 * message's row and how it's found, a conversation's or a bundle's row, a folder as a map key, and
 * search text as an FTS5 query.
 */

/** A message's row: its envelope, and its conversation. */
export type Row = { message: string; conversation: string };
export const COLUMNS = 'message, conversation';
export const BY_REF = 'account = ? AND path = ? AND uid_validity = ? AND uid = ?';
export const keyOf = (ref: MessageRef): SqlValue[] => [
  ref.account,
  ref.path,
  ref.uidValidity,
  ref.uid,
];

/** A message, as the index keeps it. */
export const messageIn = (row: Row): Message => {
  const envelope = JSON.parse(row.message) as Omit<Message, 'conversation' | 'verified'> & {
    verified?: boolean;
  };
  // Mail indexed before senders were verified counts as unverified.
  return { ...envelope, verified: envelope.verified === true, conversation: row.conversation };
};

/** A conversation's row, as the index keeps it. */
export const summaryIn = ({ summary }: { summary: string }) =>
  JSON.parse(summary) as ConversationSummary;

/** A conversation's or a bundle's row, as the index keeps it. */
export const itemIn = ({ summary }: { summary: string }) => JSON.parse(summary) as ListItem;

/** A folder as a map key. */
export const placeOf = ({ account, path }: FolderRef) => JSON.stringify([account, path]);

/**
 * Search text as an FTS5 query: every word must match, each as a prefix, so results follow typing.
 * Words are runs of letters and digits, so nothing typed can be FTS5 syntax. Nothing, without one.
 */
export function matchOf(text: string): string | undefined {
  const words = searchWords(text).slice(0, 16);
  return words.length ? words.map((word) => `"${word}"*`).join(' ') : undefined;
}
