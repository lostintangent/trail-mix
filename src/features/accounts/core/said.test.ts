import { expect, test } from 'bun:test';
import type { Account } from '../../mail/core/index.ts';
import { DEMO_SAID, isDemoOnly, refusalSaid, removeSaid } from './said.ts';

const account = (provider: Account['provider'], name = 'trl.mx'): Account => ({
  id: name,
  name,
  address: `sam@${name}`,
  provider,
  stamp: 'vermilion',
  status: 'ready',
  allowImagesFrom: [],
});

test('removing an account says what Trail Mix forgets, and that the mail stays on its server', () => {
  expect(removeSaid(account('imap'), 0)).toBe(
    'Trail Mix forgets trl.mx: the index of its mail, the copies of messages you opened, and its password. The mail stays on its server, and you can add the account again.',
  );
});

test('it counts the sends waiting in the Outbox, which won’t go', () => {
  expect(removeSaid(account('imap'), 1)).toEndWith(
    '1 message waiting in the Outbox won’t be sent, and stays in Drafts.',
  );
  expect(removeSaid(account('imap'), 3)).toEndWith(
    '3 messages waiting in the Outbox won’t be sent, and stay in Drafts.',
  );
});

test('a demo account’s mail goes with it, since Trail Mix holds it', () => {
  expect(removeSaid(account('demo', 'Personal'), 0)).toBe(
    'Personal is part of the demo mailbox, so its mail goes with it.',
  );
});

test('a deployment holding demo accounts serves only the demo mailbox', () => {
  expect(isDemoOnly([account('demo', 'Personal')])).toBe(true);
  expect(isDemoOnly([account('imap')])).toBe(false);
  expect(isDemoOnly([])).toBe(false);
});

test('the Mailroom’s refusal for a demo deployment reads as the member’s, and a host’s as it was', () => {
  expect(refusalSaid('This deployment has only the demo mailbox.')).toBe(DEMO_SAID);
  expect(refusalSaid('localhost refused the password: Authentication failed.')).toBe(
    'localhost refused the password: Authentication failed.',
  );
});
