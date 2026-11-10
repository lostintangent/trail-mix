import { expect, test } from 'bun:test';
import type { Account } from '../../mail/core/index.ts';
import { mailStatus } from './status.ts';

const account = (name: string, status: Account['status']): Account => ({
  id: name.toLowerCase(),
  name,
  address: `me@${name.toLowerCase()}.trailmix.test`,
  provider: 'demo',
  stamp: 'vermilion',
  allowImagesFrom: [],
  status,
});

test('mail is up to date once every account is ready, and being checked while one syncs', () => {
  expect(mailStatus([])).toBeUndefined();
  expect(mailStatus([account('Personal', 'ready'), account('Work', 'ready')])).toEqual({
    tone: 'ready',
    label: 'Up to date',
  });
  expect(mailStatus([account('Personal', 'ready'), account('Work', 'syncing')])).toEqual({
    tone: 'busy',
    label: 'Checking for mail',
  });
});

test('an account in trouble outranks one still syncing, and says what it needs', () => {
  expect(mailStatus([account('Personal', 'syncing'), account('Work', 'needs-sign-in')])).toEqual({
    tone: 'trouble',
    label: 'Sign in to Work again',
  });
  expect(mailStatus([account('Personal', 'error'), account('Work', 'syncing')])).toEqual({
    tone: 'trouble',
    label: 'Can’t reach Personal',
  });
});

test('several accounts in trouble are counted, so none is left out', () => {
  const accounts = [
    account('Personal', 'error'),
    account('Work', 'needs-sign-in'),
    account('School', 'error'),
  ];

  expect(mailStatus(accounts)).toEqual({ tone: 'trouble', label: '3 accounts need attention' });
});
