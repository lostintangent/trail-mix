import { expect, test } from 'bun:test';
import { savingDrafts } from './drafts.ts';
import { envelopeIndex } from './envelope-index.ts';
import { testSql } from './test-sql.ts';

test('a draft with no Message-ID can’t be sent, since its copy in Sent couldn’t be found', async () => {
  const sql = testSql();
  // As another client may file one, and its bytes read.
  const read = {
    messageId: '',
    references: [],
    from: { email: 'me@example.com' },
    to: [{ email: 'rae@example.com' }],
    cc: [],
    subject: 'Hello',
    text: 'Hi',
    headers: [],
    attachments: [],
  };
  const drafts = savingDrafts({
    sql,
    store: envelopeIndex(sql),
    bodies: { readMessage: () => Promise.resolve(read) },
  } as unknown as Parameters<typeof savingDrafts>[0]);

  const draft = { account: 'personal', path: 'Drafts', uidValidity: 1, uid: 1 };
  await expect(drafts.addressing(draft)).rejects.toThrow('That draft has no Message-ID');
});
