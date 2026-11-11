import { createServerFn } from '@tanstack/react-start';
import {
  COMMANDS,
  QUERIES,
  readCall,
  receivedCall,
  sendable,
  type Call,
  type CommandName,
  type Commands,
  type Mailroom,
  type Queries,
  type QueryName,
  type Timed,
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
  .handler(({ data, context }) => ask(context, data));

/**
 * Asks the member's Mailroom, and notes for the response's Server-Timing how long the Mailroom took
 * as the Worker saw it, and how much of that was reaching it, running there and coming back, and
 * whether it had to start first. Coming back counts an answer the Mailroom holds until what it
 * wrote is safely stored, as Cloudflare holds every answer a Durable Object sends. Names and times
 * only, never what a call carried.
 */
async function ask(
  { mailroom, timing }: { mailroom: Mailroom; timing: Timed[] },
  call: Call<QueryName | CommandName>,
) {
  const sent = Date.now();
  const at = performance.now();
  const noted = timing.length;
  try {
    const { value, reached, ran, cold } = await mailroom.answer(call, sent);
    const took = performance.now() - at;
    timing.push(
      { name: 'reached', ms: Math.max(0, reached) },
      { name: 'ran', ms: ran },
      { name: 'returned', ms: Math.max(0, took - Math.max(0, reached) - ran) },
      ...(cold ? [{ name: 'cold', note: 'The Mailroom started for this call' }] : []),
    );
    return value;
  } finally {
    timing.splice(noted, 0, { name: 'mailroom', ms: performance.now() - at, note: call.name });
  }
}

/** The browser's Mailroom: every query and command, typed as the contract has them. */
export const mailroom = Object.fromEntries([
  ...QUERIES.map((name) => [name, (...args: unknown[]) => query({ data: { name, args } })]),
  ...COMMANDS.map((name) => [
    name,
    (...args: unknown[]) => command({ data: sendable({ name, args }) }),
  ]),
]) as unknown as Queries & Commands;
