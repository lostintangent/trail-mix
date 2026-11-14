import { createServerFn } from '@tanstack/react-start';
import { ask } from './ask.ts';
import {
  COMMANDS,
  QUERIES,
  readCall,
  receivedCall,
  sendable,
  type Call,
  type Commands,
  type Queries,
} from './contract.ts';

/**
 * The two server functions every query and command travels through. A query is a GET, since it
 * changes nothing. A command is a POST, which the Worker accepts only from Trail Mix's own pages,
 * and one that carries files travels as form data. Their results are typed by the contract, which
 * holds only plain data.
 */
const query = createServerFn({ method: 'GET', strict: { output: false } })
  .validator((input: Call<string>) => readCall(QUERIES, input))
  .handler(({ data, context }) => ask(context, data));

const command = createServerFn({ method: 'POST', strict: { output: false } })
  // Either a call as JSON or, carrying files, as form data. `receivedCall` reads both.
  .validator((input: unknown) => receivedCall(COMMANDS, input))
  .handler(({ data, context }) => {
    // A command that has left the browser runs to its end, though the page closes before it
    // answers, as a phone put away straight after Send does.
    const answer = ask(context, data);
    context.waitUntil(answer.catch(() => {}));
    return answer;
  });

/**
 * The browser's Mailroom: every query and command, typed as the contract has them. A call that
 * fails carries the status the Worker answered it with, as `status`, when it answered at all.
 */
export const mailroom = Object.fromEntries([
  ...QUERIES.map((name) => [
    name,
    (...args: unknown[]) => answered((fetch) => query({ data: { name, args }, fetch })),
  ]),
  ...COMMANDS.map((name) => [
    name,
    (...args: unknown[]) => answered((fetch) => command({ data: sendable({ name, args }), fetch })),
  ]),
]) as unknown as Queries & Commands;

/** A call that failed, with the status of the Worker's answer if one came. */
export type Unanswered = Error & { status?: number };

/** Makes a call, noting the status of a failed answer on the error it brings. */
async function answered<T>(
  call: (fetch: (...args: Parameters<typeof globalThis.fetch>) => Promise<Response>) => Promise<T>,
): Promise<T> {
  let status: number | undefined;
  try {
    return await call(async (...args) => {
      const response = await fetch(...args);
      if (!response.ok) status = response.status;
      return response;
    });
  } catch (error) {
    if (error instanceof Error && status !== undefined) Object.assign(error, { status });
    throw error;
  }
}
