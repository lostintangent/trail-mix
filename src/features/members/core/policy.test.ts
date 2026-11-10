import { expect, test } from 'bun:test';
import {
  addressesOf,
  folded,
  inviteProblem,
  listOf,
  memberPolicy,
  removeProblem,
  stillAdmittedBy,
  withMember,
  withoutMember,
  type AccessPolicy,
} from './policy.ts';

const policy = (include: Record<string, unknown>[], more: Partial<AccessPolicy> = {}) =>
  ({
    id: 'p',
    name: 'Members',
    decision: 'allow',
    reusable: true,
    session_duration: '24h',
    include,
    exclude: [],
    require: [],
    ...more,
  }) as AccessPolicy;

const email = (address: string) => ({ email: { email: address } });
const OPERATOR = 'ada@example.com';

test('each email rule of the policy is a member, folded the way sign-in folds, each once', () => {
  expect(
    addressesOf(policy([email('Ada@Example.com'), email('bo@x.org'), email('ada@example.com')])),
  ).toEqual(['ada@example.com', 'bo@x.org']);
  expect(folded(' K@X.ORG ')).toBe('k@x.org');
  // Only A to Z fold, as sign-in folds: the Kelvin sign stays itself.
  expect(folded('\u212A@x.org')).toBe('\u212A@x.org');
});

test('the member list is the one Allow policy naming the operator', () => {
  const members = policy([email(OPERATOR), email('bo@x.org')]);
  const bypass = policy([{ everyone: {} }], { id: 'b', decision: 'bypass' });
  const other = policy([email('bo@x.org')], { id: 'o' });
  expect(memberPolicy([bypass, other, members], OPERATOR)).toEqual({ policy: members });
});

test('a list it can’t be sure of is said, never guessed', () => {
  expect(memberPolicy([policy([email('bo@x.org')])], OPERATOR)).toEqual({
    problem: expect.stringContaining('No Allow policy') as string,
  });
  expect(
    memberPolicy([policy([email(OPERATOR)]), policy([email(OPERATOR)], { id: 'q' })], OPERATOR),
  ).toEqual({ problem: expect.stringContaining('2 Allow policies') as string });
  // A Bypass naming the operator isn't a member list.
  expect(memberPolicy([policy([email(OPERATOR)], { decision: 'bypass' })], OPERATOR)).toEqual({
    problem: expect.stringContaining('No Allow policy') as string,
  });
});

test('the list marks the operator and their last sign-in, and says every other rule in words', () => {
  const list = listOf(
    policy(
      [
        email(OPERATOR),
        email('bo@x.org'),
        { email_domain: { domain: 'Family.example' } },
        { everyone: {} },
        { group: { id: 'g' } },
        { ip: { ip: '10.0.0.1/32' } },
      ],
      { exclude: [{ email: { email: 'eve@x.org' } }] },
    ),
    OPERATOR,
    (address) => (address === 'bo@x.org' ? '2026-11-09T10:00:00Z' : undefined),
  );
  expect(list.members).toEqual([
    { email: OPERATOR, operator: true },
    { email: 'bo@x.org', operator: false, lastSeenAt: '2026-11-09T10:00:00Z' },
  ]);
  expect(list.alsoAdmitted).toEqual([
    'Everyone at family.example',
    'Anyone with an email address. Cloudflare calls this a misconfiguration.',
    'Everyone in an Access group',
    'A ip rule',
    'Except anyone the policy’s Exclude rules name',
  ]);
});

test('adding or taking out one address leaves everything else in the policy as it was', () => {
  const held = policy([email(OPERATOR), { email_domain: { domain: 'family.example' } }], {
    exclude: [{ ip: { ip: '1.2.3.4/32' } }],
  });
  const added = withMember(held, 'Bo@X.org');
  expect(added).toEqual({ ...held, include: [...held.include!, email('bo@x.org')] });
  expect(withMember(added, 'bo@x.org')).toBe(added);
  expect(withoutMember(added, 'BO@x.org')).toEqual(held);
});

test('another rule that still admits an address is found: anyone, or everyone at its domain', () => {
  const held = policy([email(OPERATOR), { email_domain: { domain: 'family.example' } }]);
  expect(stillAdmittedBy(held, 'Kid@Family.example')).toEqual(['everyone at family.example']);
  expect(stillAdmittedBy(held, 'kid@elsewhere.example')).toEqual([]);
  expect(stillAdmittedBy(policy([{ everyone: {} }]), 'anyone@x.org')).toEqual([
    'anyone with an email address',
  ]);
});

test('an invitation for someone already in, by address or by another rule, says so', () => {
  const held = policy([
    email(OPERATOR),
    email('bo@x.org'),
    { email_domain: { domain: 'family.example' } },
  ]);
  expect(inviteProblem(held, 'cy@x.org')).toBeUndefined();
  expect(inviteProblem(held, 'cy')).toBe('Enter the whole address, such as ada@example.com.');
  expect(inviteProblem(held, ' BO@x.org')).toBe('bo@x.org is already a member.');
  expect(inviteProblem(held, 'kid@family.example')).toBe(
    'kid@family.example can already sign in, since the policy admits everyone at family.example.',
  );
});

test('the operator can’t remove themselves, however they write their address', () => {
  expect(removeProblem('ADA@example.com', OPERATOR)).toBe('You can’t remove yourself.');
  expect(removeProblem('bo@x.org', OPERATOR)).toBeUndefined();
});
