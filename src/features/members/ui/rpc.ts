import { createServerFn } from '@tanstack/react-start';
import { setResponseStatus } from '@tanstack/react-start/server';
import type { Members } from '../core/index.ts';

/**
 * The Members page's two server functions: a GET for what it reads and a POST for what it changes.
 * Each hands the call to the Worker's side for the signed-in member, which answers the operator
 * alone. Anyone else is refused with a 403, and their call reaches neither Cloudflare nor any
 * Mailroom.
 */

const QUERIES = ['isOperator', 'members'] as const;
const COMMANDS = ['invite', 'remove'] as const;
type Name = (typeof QUERIES)[number] | (typeof COMMANDS)[number];
type Call = { name: Name; args: unknown[] };

function callOf(names: readonly Name[], sent: unknown): Call {
  // A call may come as form data too, as the Mailroom's do, with the call as JSON in one part.
  const part = sent instanceof FormData ? sent.get('call') : undefined;
  const input: unknown = typeof part === 'string' ? JSON.parse(part) : sent;
  if (typeof input === 'object' && input !== null && 'name' in input && 'args' in input) {
    const { name, args } = input;
    if ((names as readonly unknown[]).includes(name) && Array.isArray(args)) {
      return { name: name as Name, args };
    }
  }
  throw new TypeError('That isn’t something the Members page can ask.');
}

async function answer(members: Members, { name, args }: Call): Promise<unknown> {
  if (name !== 'isOperator' && !(await members.isOperator())) setResponseStatus(403);
  switch (name) {
    case 'isOperator':
      return members.isOperator();
    case 'members':
      return members.members();
    case 'invite':
      if (typeof args[0] !== 'string') throw new TypeError('An invitation is for an address.');
      return members.invite(args[0]);
    case 'remove':
      if (typeof args[0] !== 'string' || typeof args[1] !== 'boolean') {
        throw new TypeError('A removal names an address, and whether to erase.');
      }
      return members.remove(args[0], args[1]);
  }
}

const read = createServerFn({ method: 'GET', strict: { output: false } })
  .validator((input: unknown) => callOf(QUERIES, input))
  .handler(({ data, context }) => answer(context.members, data));

const change = createServerFn({ method: 'POST', strict: { output: false } })
  .validator((input: unknown) => callOf(COMMANDS, input))
  .handler(({ data, context }) => answer(context.members, data));

/** The Members page's side, as a browser reaches it. */
export const members: Members = {
  isOperator: () => read({ data: { name: 'isOperator', args: [] } }) as Promise<boolean>,
  members: () => read({ data: { name: 'members', args: [] } }) as ReturnType<Members['members']>,
  invite: (email) => change({ data: { name: 'invite', args: [email] } }) as Promise<void>,
  remove: (email, erase) =>
    change({ data: { name: 'remove', args: [email, erase] } }) as Promise<void>,
};
