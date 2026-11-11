import { expect, test } from 'bun:test';
import type { Account } from '../../mail/core/index.ts';
import {
  formFor,
  formProblems,
  isSecurePort,
  nameFor,
  setupFrom,
  signInSetupFrom,
  type AccountForm,
} from './form.ts';

const ZOHO = {
  imap: { host: 'imappro.zoho.com', port: 993, secure: true },
  smtp: { host: 'smtppro.zoho.com', port: 465, secure: true },
};

const account = (address: string): Account => ({
  id: address,
  name: address,
  address,
  provider: 'imap',
  stamp: 'teal',
  status: 'ready',
  allowImagesFrom: [],
  lightPaperFrom: [],
});

const filled = (server: AccountForm['server'], change: Partial<AccountForm> = {}): AccountForm => ({
  ...formFor(server, ZOHO),
  address: 'sam@trl.example',
  password: 'an app password',
  ...(server === 'other' ? { imapHost: 'mail.example.org', smtpHost: 'mail.example.org' } : {}),
  ...change,
});

test('Zoho’s form starts from its server names, and another host’s from the usual TLS ports', () => {
  expect(formFor('zoho', ZOHO)).toMatchObject({
    imapHost: 'imappro.zoho.com',
    imapPort: '993',
    smtpHost: 'smtppro.zoho.com',
    smtpPort: '465',
  });
  expect(formFor('other', ZOHO)).toMatchObject({
    imapHost: '',
    imapPort: '993',
    smtpHost: '',
    smtpPort: '465',
  });
});

test('changing the server keeps what the member typed about themselves', () => {
  const typed = { name: 'Home', address: 'sam@trl.example', fromName: 'Sam', password: 'secret' };
  expect(formFor('other', ZOHO, typed)).toMatchObject({ ...typed, imapHost: '' });
});

test('Zoho keeps its ports and TLS under the server names typed for it', () => {
  const setup = setupFrom(
    filled('zoho', { imapHost: ' imap.zoho.com ', smtpHost: 'smtp.zoho.com', imapPort: '143' }),
    ZOHO,
  );
  expect(setup).toEqual({
    provider: 'imap',
    name: 'trl.example',
    address: 'sam@trl.example',
    preset: 'zoho',
    imap: { host: 'imap.zoho.com', port: 993, secure: true },
    smtp: { host: 'smtp.zoho.com', port: 465, secure: true },
    password: 'an app password',
  });
});

test('another host is reached on its own ports, over TLS unless the port says STARTTLS', () => {
  const setup = setupFrom(filled('other', { imapPort: '143', smtpPort: '587' }), ZOHO);
  expect(setup).not.toHaveProperty('preset');
  expect(setup.imap).toEqual({ host: 'mail.example.org', port: 143, secure: false });
  expect(setup.smtp).toEqual({ host: 'mail.example.org', port: 587, secure: false });
  expect(setupFrom(filled('other', { imapPort: '10993' }), ZOHO).imap.secure).toBe(true);
  expect([25, 143, 587].map(isSecurePort)).toEqual([false, false, false]);
  expect([465, 993].map(isSecurePort)).toEqual([true, true]);
});

test('an account without a name goes by its address’s domain, and a From name is kept trimmed', () => {
  expect(nameFor({ name: '  ', address: 'Sam@TRL.example' })).toBe('trl.example');
  expect(nameFor({ name: ' Home ', address: 'sam@trl.example' })).toBe('Home');
  expect(setupFrom(filled('zoho', { fromName: ' Sam Rivera ' }), ZOHO).fromName).toBe('Sam Rivera');
  expect(setupFrom(filled('zoho', { fromName: '  ' }), ZOHO)).not.toHaveProperty('fromName');
});

test('the password goes to the Mailroom exactly as typed', () => {
  expect(setupFrom(filled('zoho', { password: ' spaced ' }), ZOHO).password).toBe(' spaced ');
});

test('a filled form has no problems', () => {
  expect(formProblems(filled('zoho'), [])).toEqual({});
  expect(formProblems(filled('other', { imapPort: '143', smtpPort: '587' }), [])).toEqual({});
});

test('each field says what it is missing before anything is sent', () => {
  const problems = formProblems(
    filled('other', {
      address: 'sam',
      password: '',
      imapHost: '',
      smtpHost: 'smtp example',
      imapPort: '0',
      smtpPort: '65536',
    }),
    [],
  );
  expect(Object.keys(problems).toSorted()).toEqual(
    ['address', 'imapHost', 'imapPort', 'password', 'smtpHost', 'smtpPort'].toSorted(),
  );
  expect(problems.imapHost).toBe('Enter the IMAP server’s name, such as imap.example.com.');
  expect(problems.smtpPort).toBe('A port is a number from 1 to 65535.');
});

test('an address already connected is said, whatever its case', () => {
  expect(formProblems(filled('zoho'), [account('SAM@trl.example')]).address).toBe(
    'sam@trl.example is already connected.',
  );
});

test('a name or From name is at most 200 characters', () => {
  const long = 'x'.repeat(201);
  expect(formProblems(filled('zoho', { name: long, fromName: long }), [])).toEqual({
    name: 'A name can be up to 200 characters.',
    fromName: 'A name can be up to 200 characters.',
  });
});

test('Outlook asks for no password and no servers, since its member signs in at Microsoft', () => {
  const outlook = { ...formFor('outlook', ZOHO), address: 'sam@outlook.example' };
  expect(formProblems(outlook, [])).toEqual({});
  expect(formProblems({ ...outlook, address: 'sam' }, [])).toHaveProperty('address');
  expect(formProblems(outlook, [account('Sam@Outlook.example')])).toEqual({
    address: 'sam@outlook.example is already connected.',
  });
  expect(signInSetupFrom({ ...outlook, fromName: ' Sam ', password: 'typed before' })).toEqual({
    preset: 'outlook',
    name: 'outlook.example',
    address: 'sam@outlook.example',
    fromName: 'Sam',
  });
});
