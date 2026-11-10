import { expect, test } from 'bun:test';
import type { Folder, Outgoing } from '../../mail/core/index.ts';
import { viewCounts } from './counts.ts';

const folder = (
  account: string,
  path: string,
  role: Folder['role'],
  unread: number,
  total: number,
): Folder => ({
  account,
  path,
  name: path,
  ...(role && { role }),
  unread,
  total,
});

const waiting = (id: string): Outgoing => ({
  id,
  draft: { account: 'personal', path: 'Drafts', uidValidity: 1, uid: 9 },
  messageId: `<${id}@trailmix.invalid>`,
  to: [{ email: 'mina@example.com' }],
  subject: 'Plans',
  sendAt: '2026-11-10T09:00:00Z',
  state: 'waiting',
  attempts: 0,
});

test('Inbox counts unread mail in every account’s Inbox, Drafts every draft, and Outbox what waits', () => {
  const folders = [
    folder('personal', 'INBOX', 'inbox', 9, 900),
    folder('work', 'Inbox', 'inbox', 3, 300),
    folder('personal', 'Projects', undefined, 2, 40),
    folder('personal', 'Junk', 'junk', 14, 14),
    folder('personal', 'Drafts', 'drafts', 1, 2),
    folder('work', 'Drafts', 'drafts', 0, 1),
  ];

  expect(viewCounts(folders, [waiting('a')])).toEqual({ inbox: 12, drafts: 3, outbox: 1 });
});
