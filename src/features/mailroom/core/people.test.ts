import { describe, expect, test } from 'bun:test';
import { correspondentsOf, isNoReply } from './people.ts';

const mine = new Set(['me@trailmix.test', 'me@work.test']);

const from = (email: string, name?: string) => ({ from: { name, email }, to: [], cc: [] });

describe('correspondentsOf', () => {
  test('mail someone sent the member puts them in touch with its sender, by the name it gives', () => {
    expect(
      correspondentsOf(
        { ...from('Ada@Example.com', 'Ada Park'), to: [{ email: 'me@trailmix.test' }] },
        mine,
        'inbox',
      ),
    ).toEqual([{ address: 'ada@example.com', name: 'Ada Park', wrote: false }]);
  });

  test('mail the member sent puts them in touch with each person in To and Cc, once each', () => {
    expect(
      correspondentsOf(
        {
          from: { email: 'Me@TrailMix.test' },
          to: [{ email: 'rae@example.com' }, { name: 'Theo', email: 'theo@example.com' }],
          cc: [
            { name: 'Rae Chen', email: 'RAE@example.com' },
            { email: 'me@work.test' },
            { name: 'Theo Again', email: 'theo@example.com' },
          ],
        },
        mine,
        'sent',
      ),
    ).toEqual([
      { address: 'rae@example.com', name: 'Rae Chen', wrote: true },
      { address: 'theo@example.com', name: 'Theo', wrote: true },
    ]);
  });

  test('a draft or junk puts the member in touch with nobody', () => {
    const sent = {
      from: { email: 'me@trailmix.test' },
      to: [{ email: 'rae@example.com' }],
      cc: [],
    };
    expect(correspondentsOf(sent, mine, 'drafts')).toEqual([]);
    expect(correspondentsOf(from('ada@example.com'), mine, 'junk')).toEqual([]);
    expect(correspondentsOf(from('ada@example.com'), mine, undefined)).toHaveLength(1);
  });

  test('mail from a list or a no-reply address puts the member in touch with nobody', () => {
    expect(
      correspondentsOf(
        { ...from('ada@example.com'), list: { id: 'design.example.com' } },
        mine,
        'inbox',
      ),
    ).toEqual([]);
    expect(correspondentsOf(from('noreply@shop.example'), mine, 'inbox')).toEqual([]);
  });

  test('the member writing to a list or a no-reply address still puts them in touch with it', () => {
    expect(
      correspondentsOf(
        {
          from: { email: 'me@trailmix.test' },
          to: [{ email: 'no-reply@shop.example' }],
          cc: [],
          list: { id: 'shop.example' },
        },
        mine,
        'sent',
      ),
    ).toEqual([{ address: 'no-reply@shop.example', name: '', wrote: true }]);
  });

  test('an address without a domain, or a name that only repeats the address, gives no one and no name', () => {
    expect(
      correspondentsOf(
        {
          from: { email: 'me@trailmix.test' },
          to: [{ name: 'undisclosed-recipients', email: '' }, { email: 'team' }],
          cc: [{ name: ' Rae@Example.com ', email: 'rae@example.com' }],
        },
        mine,
        'sent',
      ),
    ).toEqual([{ address: 'rae@example.com', name: '', wrote: true }]);
  });
});

describe('isNoReply', () => {
  test('knows the shapes senders write a no-reply address in, and a mail server’s own', () => {
    for (const address of [
      'noreply@example.com',
      'NoReply@example.com',
      'no-reply@example.com',
      'no_reply@example.com',
      'no.reply@example.com',
      'donotreply@example.com',
      'do-not-reply@example.com',
      'do_not_reply@example.com',
      'dont-reply@example.com',
      'notifications-noreply@example.com',
      'noreply+receipts@example.com',
      'noreply2@example.com',
      'MAILER-DAEMON@example.com',
      'noreply',
    ])
      expect([address, isNoReply(address)]).toEqual([address, true]);
  });

  test('leaves alone an address that only looks like one', () => {
    for (const address of [
      'nora@example.com',
      'reply@example.com',
      'replies@example.com',
      'snoreply@example.com',
      'noreplyx@example.com',
      'ada@noreply.example.com',
      'nor',
    ])
      expect([address, isNoReply(address)]).toEqual([address, false]);
  });
});
