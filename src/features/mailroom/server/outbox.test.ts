import { expect, test } from 'bun:test';
import type { MessageRef, Outgoing } from '../../mail/core/index.ts';
import { SendFailure, type MailProvider } from '../../providers/index.ts';
import { outboxQueue } from './outbox.ts';
import { upgrade } from './schema.ts';
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

/** A queue whose host accepts everything, and files its own copy, as the test asks it to. */
function hostThatAccepts(sql = testSql()) {
  const submitted: string[] = [];
  const provider = () =>
    Promise.resolve({
      submit: (_: MessageRef, messageId: string) => {
        submitted.push(messageId);
        return Promise.resolve('sent' as const);
      },
      file: () => Promise.resolve('filed' as const),
    } as unknown as MailProvider);
  const queue = outboxQueue({ sql, provider, hint: () => {}, sent: () => {} });
  return { queue, submitted };
}

const message = (uid: number) => ({
  draft: draft('personal', uid),
  messageId: `<${uid}@example.com>`,
  to: [],
  subject: '',
});

test('a press asked again answers with its send, and once it went, as it went, and it goes once', async () => {
  const { queue, submitted } = hostThatAccepts();
  const first = queue.send(message(1), NOW, undefined, NOW, 'press');
  expect(queue.send(message(1), NOW, undefined, NOW, 'press')).toEqual(first);

  await queue.run(() => LATER);
  expect(queue.list()).toEqual([]);
  // The answer to the first ask was lost, and the device asks once more, after it went.
  expect(queue.send(message(1), LATER, undefined, LATER, 'press')).toMatchObject({ id: 'press' });
  await queue.run(() => LATER);
  expect(queue.list()).toEqual([]);
  expect(submitted).toEqual(['<1@example.com>']);
});

test('a press asked again once it was undone is refused, and schedules nothing', () => {
  const { queue } = hostThatAccepts();
  queue.send(message(1), NOW, undefined, NOW, 'press');
  expect(queue.cancel('press', NOW)).toEqual(draft('personal', 1));
  expect(() => queue.send(message(1), NOW, undefined, NOW, 'press')).toThrow(
    'The send was undone.',
  );
  expect(queue.pressed('press')).toEqual({ came: { undone: draft('personal', 1) } });
  expect(queue.list()).toEqual([]);
});

test('an Undo that comes before its press keeps the press from ever being sent', () => {
  const { queue } = hostThatAccepts();
  queue.undone('press', NOW);
  expect(() => queue.send(message(1), NOW, undefined, NOW, 'press')).toThrow(
    'The send was undone.',
  );
  expect(queue.list()).toEqual([]);
});

test('a press cut short before it scheduled anything may be taken again, but not once undone', () => {
  const { queue } = hostThatAccepts();
  queue.press('press', NOW);
  queue.unpress('press');
  expect(queue.pressed('press')).toBeUndefined();

  queue.press('again', NOW);
  queue.undone('again', NOW, draft('personal', 2));
  queue.unpress('again');
  expect(queue.pressed('again')).toEqual({ came: { undone: draft('personal', 2) } });
});

test('removing an account undoes the presses of its sends', () => {
  const { queue } = hostThatAccepts();
  queue.send(message(1), NOW, undefined, NOW, 'one');
  queue.send({ ...message(2), draft: draft('work', 2) }, NOW, undefined, NOW, 'two');
  queue.forget('work');
  expect(queue.pressed('two')).toEqual({ came: { undone: null } });
  expect(queue.pressed('one')?.send).toMatchObject({ id: 'one' });
});

test('a press is kept for a week, and for as long as its send waits', async () => {
  const { queue } = hostThatAccepts();
  const week = 7 * 24 * 60 * 60 * 1000;
  const weekOn = (ms: number) => new Date(Date.parse(NOW) + week + ms).toISOString();
  queue.undone('undone', NOW);
  queue.send(message(1), NOW, weekOn(60_000), NOW, 'waiting');
  await queue.run(() => weekOn(0));
  expect(queue.pressed('undone')).toBeDefined();

  await queue.run(() => weekOn(1));
  expect(queue.pressed('undone')).toBeUndefined();
  expect(queue.pressed('waiting')?.send).toMatchObject({ id: 'waiting' });
});

test('every send already waiting when presses were first kept is its own press', () => {
  const sql = testSql(23);
  const waiting: Outgoing = {
    ...message(1),
    id: 'waiting',
    state: 'waiting',
    attempts: 0,
    sendAt: SCHEDULED,
  };
  sql.run(
    `INSERT INTO outbox (id, account, outgoing) VALUES (?, ?, ?)`,
    'waiting',
    'personal',
    JSON.stringify(waiting),
  );
  upgrade(sql);
  const { queue } = hostThatAccepts(sql);
  expect(queue.pressed('waiting')).toEqual({ send: waiting });
  // So its Undo, asked again, answers as the first did.
  queue.cancel('waiting', NOW);
  expect(queue.pressed('waiting')).toEqual({ came: { undone: draft('personal', 1) } });
});
