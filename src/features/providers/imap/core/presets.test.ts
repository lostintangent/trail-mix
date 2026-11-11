import { describe, expect, test } from 'bun:test';
import { authServersFor, PRESETS, withStandIn } from './presets.ts';

const outlook = PRESETS.outlook;
const imap = { host: 'localhost', port: 4993, secure: true };
const smtp = { host: '127.0.0.1', port: 4587, secure: false };
const standIn = (authority: string, hosts: object = { imap, smtp }) =>
  JSON.stringify({ authority, ...hosts });

describe('a test’s stand-in for a vendor', () => {
  test('replaces where it signs in, and its hosts, when all of it is on this machine', () => {
    for (const authority of [
      'http://127.0.0.1:4080/consumers',
      'http://localhost:4080/consumers',
      'http://[::1]:4080/consumers',
    ]) {
      const stood = withStandIn(outlook, standIn(authority));
      expect(stood.device?.authority).toBe(authority);
      expect(stood.imap).toEqual(imap);
      expect(stood.smtp).toEqual(smtp);
    }
    expect(
      withStandIn(outlook, standIn('http://127.0.0.1:4080/consumers/')).device?.authority,
    ).toBe('http://127.0.0.1:4080/consumers');
  });

  test('is ignored when its sign-in names anywhere else, however it’s dressed', () => {
    for (const authority of [
      'https://login.evil.com/consumers',
      'http://localhost.evil.com/consumers',
      'http://127.0.0.1.nip.io/consumers',
      'https://127.0.0.1@login.evil.com/consumers',
      'http://127.0.0.1:4080@login.evil.com/consumers',
      'http://user:pass@127.0.0.1:4080/consumers',
      'file://localhost/etc',
      'ftp://127.0.0.1:4080/consumers',
      'not a url',
    ]) {
      expect(withStandIn(outlook, standIn(authority))).toEqual(outlook);
    }
  });

  test('is ignored whole when a host is elsewhere, or it isn’t one', () => {
    const authority = 'http://127.0.0.1:4080/consumers';
    const elsewhere = { host: 'localhost.evil.com', port: 993, secure: true };
    expect(withStandIn(outlook, standIn(authority, { imap: elsewhere, smtp }))).toEqual(outlook);
    expect(withStandIn(outlook, standIn(authority, { imap, smtp: elsewhere }))).toEqual(outlook);
    expect(withStandIn(outlook, standIn(authority, { imap }))).toEqual(outlook);
    for (const given of [undefined, '', '{', 'null', '"http://127.0.0.1:4080"']) {
      expect(withStandIn(outlook, given)).toEqual(outlook);
    }
  });

  test('is ignored for a preset with no sign-in of its own', () => {
    const zoho = PRESETS.zoho;
    expect(withStandIn(zoho, standIn('http://127.0.0.1:4080/consumers'))).toEqual(zoho);
  });
});

describe('the servers an account trusts to sign Authentication-Results', () => {
  test('are its own Zoho data center’s, by the domain of its host, set up with a preset or not', () => {
    for (const host of ['imappro.zoho.com', 'imap.zoho.com', 'IMAP.Zoho.com.']) {
      expect(authServersFor(host)).toEqual(['mx.zohomail.com']);
    }
    expect(authServersFor('imappro.zoho.eu')).toEqual(['mx.zohomail.eu', 'mx.zoho.eu']);
    expect(authServersFor('imap.zoho.com.au')).not.toContain('mx.zohomail.com');
  });

  test('are none for a server no preset names, or one that writes them unnamed', () => {
    for (const host of [
      PRESETS.outlook.imap.host,
      'mail.example.org',
      'imap.notzoho.com',
      'zoho.com.example.org',
      'localhost',
    ]) {
      expect(authServersFor(host)).toEqual([]);
    }
  });

  test('come from a test’s stand-in only for a host on this machine', () => {
    const standIn = JSON.stringify({
      localhost: ['mx.trailmix.test'],
      '127.0.0.1': 'mx.trailmix.test',
      'imap.example.org': ['mx.evil.test'],
    });
    expect(authServersFor('localhost', standIn)).toEqual(['mx.trailmix.test']);
    expect(authServersFor('127.0.0.1', standIn)).toEqual([]);
    expect(authServersFor('::1', standIn)).toEqual([]);
    expect(authServersFor('imap.example.org', standIn)).toEqual([]);
    expect(authServersFor('imappro.zoho.com', standIn)).toEqual(['mx.zohomail.com']);
    expect(authServersFor('localhost', 'not json')).toEqual([]);
  });
});
