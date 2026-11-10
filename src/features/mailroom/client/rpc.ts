import { createServerFn } from '@tanstack/react-start';
import {
  COMMANDS,
  QUERIES,
  readCall,
  receivedCall,
  sendable,
  type Call,
  type Commands,
  type Mailroom,
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
  .handler(({ data, context }) => ask(context.mailroom, data));

const command = createServerFn({ method: 'POST', strict: { output: false } })
  // Either a call as JSON or, carrying files, as form data. `receivedCall` reads both.
  .validator((input: unknown) => receivedCall(COMMANDS, input))
  .handler(({ data, context }) => ask(context.mailroom, data));

type Name = keyof Queries | keyof Commands;

function ask(mailroom: Mailroom, { name, args }: Call<Name>) {
  const methods = mailroom as unknown as Record<Name, (...args: unknown[]) => Promise<unknown>>;
  return methods[name](...args);
}

/** The browser's Mailroom: every query and command, typed as the contract has them. */
export const mailroom = Object.fromEntries([
  ...QUERIES.map((name) => [name, (...args: unknown[]) => query({ data: { name, args } })]),
  ...COMMANDS.map((name) => [
    name,
    (...args: unknown[]) => command({ data: sendable({ name, args }) }),
  ]),
]) as unknown as Queries & Commands;
