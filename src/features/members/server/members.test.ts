import { expect, test } from 'bun:test';
import { cloudflareStandIn, STAND_IN_AUD } from '../../../../tests/cloudflare-stand-in.ts';
import { cloudflareApi } from './cloudflare.ts';
import { membersFor } from './members.ts';

const OPERATOR = 'ada@example.com';

/** The Members side for a caller, against a stand-in Cloudflare, with each Mailroom it reaches. */
function setUp(
  caller = OPERATOR,
  standIn = cloudflareStandIn({ members: [OPERATOR, 'bo@x.org'] }),
) {
  const reached: [member: string, did: string][] = [];
  const failing = new Set<string>();
  const members = membersFor({
    caller,
    operator: OPERATOR,
    audience: STAND_IN_AUD,
    api: cloudflareApi({
      base: 'https://cloudflare.test/client/v4',
      account: 'account',
      token: 'token',
      fetch: ((input: RequestInfo | URL, init?: RequestInit) =>
        standIn.handle(new Request(input, init))) as typeof fetch,
    }),
    mailroomOf: (member) => ({
      closeDevices: () => {
        reached.push([member, 'closeDevices']);
        return failing.has('closeDevices')
          ? Promise.reject(new Error('The Mailroom is gone.'))
          : Promise.resolve();
      },
      eraseEverything: () => {
        reached.push([member, 'eraseEverything']);
        return Promise.resolve();
      },
    }),
  });
  return { members, standIn, reached, failing };
}

test('the operator sees each member with their last sign-in', async () => {
  const { members, standIn } = setUp();
  standIn.lastSeen.set('bo@x.org', '2026-11-09T10:00:00Z');
  expect(await members.isOperator()).toBe(true);
  expect(await members.members()).toEqual({
    members: [
      { email: OPERATOR, operator: true },
      { email: 'bo@x.org', operator: false, lastSeenAt: '2026-11-09T10:00:00Z' },
    ],
    alsoAdmitted: [],
  });
});

test('anyone else is refused before Cloudflare or any Mailroom is reached', async () => {
  const { members, standIn, reached } = setUp('bo@x.org');
  expect(await members.isOperator()).toBe(false);
  await expect(members.members()).rejects.toThrow('Only the operator can manage members.');
  await expect(members.invite('cy@x.org')).rejects.toThrow('Only the operator can manage members.');
  await expect(members.remove(OPERATOR, true)).rejects.toThrow(
    'Only the operator can manage members.',
  );
  expect(standIn.calls).toEqual([]);
  expect(reached).toEqual([]);
});

test('an invitation adds the address, folded, and is done only once Cloudflare’s list shows it', async () => {
  const { members, standIn } = setUp();
  await members.invite(' Cy@X.org ');
  expect(standIn.members).toEqual([OPERATOR, 'bo@x.org', 'cy@x.org']);
  expect(standIn.policy).toMatchObject({ name: 'Trail Mix members', session_duration: '24h' });
  await expect(members.invite('cy@x.org')).rejects.toThrow('cy@x.org is already a member.');
});

test('a change Cloudflare takes but doesn’t show yet is never reported done', async () => {
  const { members, standIn } = setUp();
  standIn.lagging.writes = true;
  await expect(members.invite('cy@x.org')).rejects.toThrow(
    'Cloudflare took the change, but its member list doesn’t show it yet.',
  );
});

test('removing takes them off the list, then ends their sign-in, then closes and erases their Mailroom alone', async () => {
  const { members, standIn, reached } = setUp();
  await members.remove('Bo@X.org', true);
  expect(standIn.members).toEqual([OPERATOR]);
  const changes = standIn.calls.filter(({ method }) => method !== 'GET');
  expect(changes.map(({ method, path }) => `${method} ${path}`)).toEqual([
    'PUT /access/policies/policy-1',
    'POST /access/organizations/revoke_user',
  ]);
  expect(changes[1]?.body).toEqual({ email: 'bo@x.org' });
  expect(reached).toEqual([
    ['bo@x.org', 'closeDevices'],
    ['bo@x.org', 'eraseEverything'],
  ]);
});

test('removing without erasing closes their connections and keeps their Mailroom', async () => {
  const { members, reached } = setUp();
  await members.remove('bo@x.org', false);
  expect(reached).toEqual([['bo@x.org', 'closeDevices']]);
});

test('a revoke that fails is said, and the next try finishes what is left', async () => {
  const { members, standIn, reached } = setUp();
  standIn.refusing.set('/access/organizations/revoke_user', 'Authentication error');
  await expect(members.remove('bo@x.org', true)).rejects.toThrow(
    'bo@x.org is off the list, but Trail Mix couldn’t end their sign-in, so they may stay signed in until their session ends. Cloudflare refused it: Authentication error',
  );
  expect(standIn.members).toEqual([OPERATOR]);
  expect(reached).toEqual([]);

  standIn.refusing.clear();
  await members.remove('bo@x.org', true);
  // Already off the list, so the policy isn't written again.
  expect(standIn.calls.filter(({ method }) => method === 'PUT')).toHaveLength(1);
  expect(reached).toEqual([
    ['bo@x.org', 'closeDevices'],
    ['bo@x.org', 'eraseEverything'],
  ]);
});

test('connections that can’t be closed are said, with the rest done', async () => {
  const { members, failing } = setUp();
  failing.add('closeDevices');
  await expect(members.remove('bo@x.org', true)).rejects.toThrow(
    'bo@x.org is off the list and signed out, but Trail Mix couldn’t close their connections and erase what it holds for them. The Mailroom is gone.',
  );
});

test('someone another rule still admits is never reported out', async () => {
  const standIn = cloudflareStandIn({
    members: [OPERATOR, 'kid@family.example'],
    alsoInclude: [{ email_domain: { domain: 'family.example' } }],
  });
  const { members } = setUp(OPERATOR, standIn);
  await expect(members.remove('kid@family.example', false)).rejects.toThrow(
    'kid@family.example is off the list, but can still sign in, since the policy admits everyone at family.example.',
  );
  expect(standIn.members).toEqual([OPERATOR]);
});

test('a policy that belongs to its application is written back as the application’s', async () => {
  const standIn = cloudflareStandIn({ members: [OPERATOR], reusable: false });
  const { members } = setUp(OPERATOR, standIn);
  await members.invite('cy@x.org');
  expect(standIn.calls.find(({ method }) => method === 'PUT')?.path).toBe(
    '/access/apps/app-1/policies/policy-1',
  );
});

test('the operator is never removed, and a list Cloudflare refuses is said in its words', async () => {
  const { members, standIn } = setUp();
  await expect(members.remove('ADA@example.com', true)).rejects.toThrow(
    'You can’t remove yourself.',
  );
  standIn.refusing.set('/access/apps', 'Authentication error');
  await expect(members.members()).rejects.toThrow('Cloudflare refused it: Authentication error');
});

test('without the member-list token, the page points at the dashboard', async () => {
  const members = membersFor({
    caller: OPERATOR,
    operator: OPERATOR,
    audience: STAND_IN_AUD,
    api: undefined,
    mailroomOf: () => {
      throw new Error('No Mailroom is reached.');
    },
  });
  await expect(members.members()).rejects.toThrow('managed in the Cloudflare dashboard');
});
