import { expect, test } from 'bun:test';
import type { MessageRef } from '../../mail/core/index.ts';
import { SendFailure, type MailProvider } from '../../providers/index.ts';
import { outboxQueue } from './outbox.ts';
import { testSql } from './test-sql.ts';

const NOW = '2026-11-10T09:00:00.000Z';
/** When the undo window opened at `NOW` closes. */
const SCHEDULED = '2026-11-10T09:00:10.000Z';
const LATER = '2026-11-10T09:01:00.000Z';

const draft = (account: string, uid: number): MessageRef => ({
  account,
  path: 'Drafts',
  uidValidity: 1,
  uid,
});

test('once a host fails for now, its account’s other sends wait for the next wake', async () => {
  const tried: string[] = [];
  const provider = () =>
    Promise.resolve({
      submit: (ref: MessageRef, messageId: string) => {
        tried.push(messageId);
        return ref.account === 'down'
          ? Promise.reject(new SendFailure('Couldn’t reach smtp.down.example', true))
          : Promise.resolve('sent' as const);
      },
      file: () => Promise.resolve('filed' as const),
    } as unknown as MailProvider);
  const queue = outboxQueue({ sql: testSql(), provider, hint: () => {}, sent: () => {} });
  for (const [account, uid] of [
    ['down', 1],
    ['down', 2],
    ['up', 3],
  ] as const) {
    queue.send(
      { draft: draft(account, uid), messageId: `<${uid}@example.com>`, to: [], subject: '' },
      NOW,
      NOW,
    );
  }

  await queue.run(() => LATER);

  // One of the two sends to the host that's down tried it, and the other never did.
  expect(tried.filter((id) => id !== '<3@example.com>')).toHaveLength(1);
  expect(tried).toContain('<3@example.com>');
  const down = queue.list().filter(({ draft }) => draft.account === 'down');
  expect(down.find(({ attempts }) => attempts === 1)).toMatchObject({
    state: 'waiting',
    error: 'Couldn’t reach smtp.down.example',
  });
  expect(down.find(({ attempts }) => attempts === 0)).toMatchObject({
    state: 'waiting',
    sendAt: SCHEDULED,
  });
  expect(queue.list().some(({ draft }) => draft.account === 'up')).toBe(false);
});
