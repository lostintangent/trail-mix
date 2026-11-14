import type { Folder } from '../../mail/core/index.ts';
import { inside } from './names.ts';

const counted = (count: number, one: string, many: string) =>
  `${count} ${count === 1 ? one : many}`;

/**
 * What the question before a delete says goes with a folder, which can't be brought back: the
 * folders inside it, and the messages in them all.
 */
export function deleteSaid(folder: Folder, folders: readonly Folder[]): string {
  const within = inside(
    folder,
    folders.filter(({ account }) => account === folder.account),
  );
  const messages = [folder, ...within].reduce((sum, { total }) => sum + total, 0);
  const what = [
    ...(within.length ? [counted(within.length, 'folder inside it', 'folders inside it')] : []),
    ...(messages ? [counted(messages, 'message', 'messages')] : []),
  ];
  const goes = what.length ? `${folder.name}, with ${what.join(' and ')},` : folder.name;
  return `${goes} will be deleted from the mail server. This can’t be undone.`;
}
