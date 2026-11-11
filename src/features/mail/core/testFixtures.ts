import { applySyncEvent, memoryIndex, type MemoryIndex, type SyncEvent } from './fold.ts';
import type { Envelope, FolderRef, FolderRole } from './model.ts';

/** Two accounts: `personal` with a folder for every role and one of its own, and `work` with an Inbox. */
export const FOLDERS: (FolderRef & { role?: FolderRole })[] = [
  { account: 'personal', path: 'INBOX', role: 'inbox' },
  { account: 'personal', path: 'Sent', role: 'sent' },
  { account: 'personal', path: 'Archive', role: 'archive' },
  { account: 'personal', path: 'Drafts', role: 'drafts' },
  { account: 'personal', path: 'Trash', role: 'trash' },
  { account: 'personal', path: 'Junk', role: 'junk' },
  { account: 'personal', path: 'Projects' },
  { account: 'work', path: 'INBOX', role: 'inbox' },
];

let nextUid = 1;

/**
 * A message in `personal`'s Inbox, named by its subject, whose Message-ID is `<subject@example.com>` unless
 * `init` says otherwise. Each one gets a UID of its own.
 */
export function envelope(subject: string, init: Partial<Envelope> = {}): Envelope {
  return {
    account: 'personal',
    path: 'INBOX',
    uidValidity: 1,
    uid: nextUid++,
    messageId: `<${subject}@example.com>`,
    references: [],
    from: { name: 'Ada Park', email: 'ada@example.com' },
    to: [{ email: 'me@trailmix.test' }],
    cc: [],
    subject,
    date: '2026-11-09T12:00:00.000Z',
    preview: '',
    flags: { seen: false, flagged: false, answered: false, draft: false },
    hasAttachments: false,
    verified: false,
    ...init,
  };
}

export function arrive(...envelopes: Envelope[]): SyncEvent[] {
  return envelopes.map((envelope) => ({ type: 'message', envelope }));
}

/** Folds events one at a time, writing each change before the next event is read. */
export function fold(events: readonly SyncEvent[], index = memoryIndex(FOLDERS)): MemoryIndex {
  return events.reduce((index, event) => index.apply(applySyncEvent(index, event)), index);
}

/** The index's conversations as lists of subjects, so a test reads as who sits with whom. */
export function threads(index: MemoryIndex): string[][] {
  const groups = Map.groupBy(index.messages, (message) => message.conversation);
  return [...groups.values()]
    .map((messages) => messages.map((message) => message.subject).sort())
    .sort((a, b) => a[0]!.localeCompare(b[0]!));
}
