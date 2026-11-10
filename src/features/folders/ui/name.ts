import type { Folder, FolderRole } from '../../mail/core/index.ts';

const ROLE_NAMES: Record<FolderRole, string> = {
  inbox: 'Inbox',
  archive: 'Archive',
  sent: 'Sent',
  drafts: 'Drafts',
  junk: 'Junk',
  trash: 'Trash',
};

/**
 * What Trail Mix calls a folder. One with a role goes by its role, whatever the server calls it,
 * so "INBOX", "Sent Items" and "[Gmail]/Sent Mail" read as Inbox and Sent. Any other folder keeps
 * its own name.
 */
export const folderName = ({ role, name }: Folder) => (role ? ROLE_NAMES[role] : name);
