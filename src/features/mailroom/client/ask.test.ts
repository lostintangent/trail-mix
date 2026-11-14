import { expect, test } from 'bun:test';
import { ask } from './ask.ts';
import type { Answered, Call, CommandName, Mailroom, QueryName, Timed } from './contract.ts';

/** A failure as Cloudflare reports one between the Worker and a Durable Object. */
const failure = (message: string, marks: { retryable?: boolean; overloaded?: boolean }) =>
  Object.assign(new Error(message), marks);
const RESET = failure('Durable Object reset because its code was updated.', { retryable: true });
const OVERLOADED = failure('Durable Object is overloaded.', { retryable: true, overloaded: true });

/** A Mailroom reached through a new stub each time, whose answers come in turn. */
function reaching(...answers: unknown[]) {
  let stubs = 0;
  const waited: number[] = [];
  const mailroom = () => {
    const turn = stubs++;
    return {
      answer: (_call: Call<QueryName | CommandName>): Promise<Answered> => {
        const answer = answers[turn];
        return answer instanceof Error
          ? Promise.reject(answer)
          : Promise.resolve({ value: answer, reached: 1, ran: 0, spent: [], cold: false });
      },
    } as unknown as Mailroom;
  };
  const timing: Timed[] = [];
  const asking = (name: QueryName | CommandName) =>
    ask({ mailroom, timing }, { name, args: [] }, (ms) => {
      waited.push(ms);
      return Promise.resolve();
    });
  return { asking, timing, waited, stubs: () => stubs };
}

test('a query the Mailroom failed for a moment is asked again, through a new stub, and answers', async () => {
  const mailroom = reaching(RESET, RESET, ['the accounts']);
  expect(await mailroom.asking('accounts')).toEqual(['the accounts']);
  expect(mailroom.stubs()).toBe(3);
  // Waits that grow, under about a second and a quarter in all.
  expect(mailroom.waited).toHaveLength(2);
  expect(mailroom.waited[1]!).toBeGreaterThan(mailroom.waited[0]!);
  expect(mailroom.waited.reduce((sum, ms) => sum + ms, 0)).toBeLessThanOrEqual(1250);
  expect(mailroom.timing.filter(({ name }) => name === 'retried')).toHaveLength(2);
});

test('a command a second run would change is never asked again, nor an overloaded Mailroom', async () => {
  for (const [name, error] of [
    ['saveDraft', RESET],
    ['move', RESET],
    ['accounts', OVERLOADED],
    ['accounts', failure('There is no such account.', {})],
  ] as const) {
    const mailroom = reaching(error, ['an answer']);
    await expect(mailroom.asking(name)).rejects.toBe(error);
    expect({ name, stubs: mailroom.stubs() }).toEqual({ name, stubs: 1 });
  }
});

test('a command a second run leaves as it was is asked again', async () => {
  const mailroom = reaching(RESET, undefined);
  expect(await mailroom.asking('setFlags')).toBeUndefined();
  expect(mailroom.stubs()).toBe(2);
});

test('a Mailroom that keeps failing is given up on after three tries, with its error', async () => {
  const mailroom = reaching(RESET, RESET, RESET, ['too late']);
  await expect(mailroom.asking('conversation')).rejects.toBe(RESET);
  expect(mailroom.stubs()).toBe(3);
});
