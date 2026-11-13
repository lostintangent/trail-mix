import type { Folder, Message } from '../../mail/core/index.ts';

/**
 * The folder a conversation lies in, which the reader names under its subject. A conversation
 * gathers its account's Inbox, Sent, Archive and Drafts, and it lies where its newest message from
 * outside Sent and Drafts is: in the Inbox once a reply arrives there, though older ones were
 * archived. One with nothing else, such as a message nobody has answered yet, lies in Sent or
 * Drafts. A message in a folder that isn't listed is passed over.
 */
export function folderOf(
  conversation: readonly Message[],
  folders: readonly Folder[],
): Folder | undefined {
  const located = conversation
    .toSorted((a, b) => a.date.localeCompare(b.date))
    .map((message) =>
      folders.find(({ account, path }) => account === message.account && path === message.path),
    );
  const newest = located.at(-1);
  return located.findLast((folder) => folder && !isOwnWriting(folder)) ?? newest;
}

/**
 * The messages that reached the member: everything outside Sent and Drafts, so what a conversation
 * is about reads from what others wrote, though the member replied. A message in a folder that
 * isn't listed counts as reached.
 */
export function receivedIn(
  conversation: readonly Message[],
  folders: readonly Folder[],
): Message[] {
  return conversation.filter((message) => {
    const folder = folders.find(
      ({ account, path }) => account === message.account && path === message.path,
    );
    return !folder || !isOwnWriting(folder);
  });
}

/** Whether a folder holds the member's own writing: what was sent, and what is being written. */
const isOwnWriting = ({ role }: Folder) => role === 'sent' || role === 'drafts';
