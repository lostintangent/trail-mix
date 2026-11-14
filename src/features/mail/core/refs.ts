import type { Folder, FolderRef, MessageRef } from './model.ts';

/** Just a message's identity, as a command, a query or an address names it. */
export const refOf = ({ account, path, uidValidity, uid }: MessageRef): MessageRef => ({
  account,
  path,
  uidValidity,
  uid,
});

/** A message's identity as one string, to key it by in a set, a map or a list. */
export const refKey = ({ account, path, uidValidity, uid }: MessageRef) =>
  [account, path, uidValidity, uid].join('\u0000');

/** Whether two refs name the same folder. */
export const sameFolder = (a: FolderRef, b: FolderRef) =>
  a.account === b.account && a.path === b.path;

/** The folder a ref names, while the server lists it. */
export const folderAt = (folders: readonly Folder[], ref: FolderRef) =>
  folders.find((folder) => sameFolder(folder, ref));

/** Whether two refs name the same message. */
export const sameRef = (a: MessageRef, b: MessageRef) =>
  sameFolder(a, b) && a.uidValidity === b.uidValidity && a.uid === b.uid;
