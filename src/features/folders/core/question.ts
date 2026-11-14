import type { Folder } from '../../mail/core/index.ts';
import { inside } from './names.ts';

const counted = (count: number, one: string, many: string) =>
  `${count} ${count === 1 ? one : many}`;

/** What deleting a folder takes with it: the folders inside it, and the messages in them all. */
export function whatGoes(folder: Folder, folders: readonly Folder[]) {
  const within = inside(folder, folders);
  return {
    folders: within.length,
    messages: [folder, ...within].reduce((sum, { total }) => sum + total, 0),
  };
}

/** What the question before a delete says goes with a folder, which can't be brought back. */
export function deleteSaid(folder: Folder, folders: readonly Folder[]): string {
  const mine = folders.filter(({ account }) => account === folder.account);
  const { folders: within, messages } = whatGoes(folder, mine);
  const what = [
    ...(within ? [counted(within, 'folder inside it', 'folders inside it')] : []),
    ...(messages ? [counted(messages, 'message', 'messages')] : []),
  ];
  const goes = what.length ? `${folder.name}, with ${what.join(' and ')},` : folder.name;
  return `${goes} will be deleted from the mail server. This can’t be undone.`;
}
