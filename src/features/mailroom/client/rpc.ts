import { createServerFn } from '@tanstack/react-start';
import { ask, isCloudflareFailure } from './ask.ts';
import { isRefusal } from './failed.ts';
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
  .handler(({ data, context }) => answering(ask(context, data)));

const command = createServerFn({ method: 'POST', strict: { output: false } })
  // Either a call as JSON or, carrying files, as form data. `receivedCall` reads both.
  .validator((input: unknown) => receivedCall(COMMANDS, input))
  .handler(({ data, context }) => {
    // A command that has left the browser runs to its end, though the page closes before it
    // answers, as a phone put away straight after Send does.
    const answer = ask(context, data);
    context.waitUntil(answer.catch(() => {}));
    return answering(answer);
  });

/**
 * A call's answer, which says when it failed whether the Mailroom refused it. The server function
 * answers a refusal 200, with the error's message alone, so a failure of Cloudflare's, which leaves
 * open whether the call ran, goes instead as a 503 of its own, with its message.
 */
async function answering(answer: Promise<unknown>): Promise<unknown> {
  try {
    return await answer;
  } catch (error) {
    if (!isCloudflareFailure(error)) throw error;
    // eslint-disable-next-line @typescript-eslint/only-throw-error -- Start answers with a thrown Response.
    throw new Response(error instanceof Error ? error.message : '', { status: 503 });
  }
}

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

/**
 * A call that failed, with the status of the Worker's answer if one came, and whether that answer
 * refused it, so that asking again would only be refused again.
 */
export type Unanswered = Error & { status?: number; isRefused?: boolean };

/** Makes a call, noting on the error a failed one brings what answer came back for it. */
async function answered<T>(
  call: (fetch: (...args: Parameters<typeof globalThis.fetch>) => Promise<Response>) => Promise<T>,
): Promise<T> {
  let response: Response | undefined;
  try {
    return await call(async (...args) => (response = await fetch(...args)));
  } catch (thrown) {
    // A 503 of the Worker's own comes as the response itself.
    const error =
      thrown instanceof Response ? new Error(await thrown.text().catch(() => '')) : thrown;
    if (error instanceof Error && response) {
      if (!response.ok) Object.assign(error, { status: response.status });
      Object.assign(error, { isRefused: isRefusal(response, error) });
    }
    throw error;
  }
}
