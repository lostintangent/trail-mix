import { expect, test } from 'bun:test';
import { signInFailure } from './signin.ts';

const imap = { host: 'imap.example.com', port: 993, secure: true };
const smtp = { host: 'smtp.example.com', port: 465, secure: true };
const credentials = { user: 'me@example.com', by: 'password' as const, secrets: ['hunter2'] };

test('a refused password is told in the host’s own words, without the IMAP tag and status', () => {
  expect(
    signInFailure(
      {
        authenticationFailed: true,
        response: '2 NO [AUTHENTICATIONFAILED] Authentication failed.',
      },
      imap,
      credentials,
    ),
  ).toBe('imap.example.com refused the password: [AUTHENTICATIONFAILED] Authentication failed.');
  expect(
    signInFailure(
      { code: 'EAUTH', response: '535 5.7.139 Authentication unsuccessful' },
      smtp,
      credentials,
    ),
  ).toBe('smtp.example.com refused the password: 535 5.7.139 Authentication unsuccessful');
  expect(signInFailure({ authenticationFailed: true }, imap, credentials)).toBe(
    'imap.example.com refused the password.',
  );
});

test('a host that never answered is named with its port, whatever the client said', () => {
  for (const failure of [
    { code: 'ENOTFOUND' },
    { code: 'ECONNECTION' },
    { code: 'ETIMEDOUT' },
    {},
    { response: '  ' },
  ]) {
    expect(signInFailure(failure, imap, credentials)).toBe(
      'Trail Mix couldn’t reach imap.example.com on port 993.',
    );
  }
});

test('any other answer is the host’s reason for turning the sign-in away', () => {
  expect(
    signInFailure({ response: '* BYE [UNAVAILABLE] Too many connections' }, imap, credentials),
  ).toBe('imap.example.com refused the sign-in: [UNAVAILABLE] Too many connections');
  expect(
    signInFailure({ code: 'EPROTOCOL', response: '421 4.7.0 Try again later' }, smtp, credentials),
  ).toBe('smtp.example.com refused the sign-in: 421 4.7.0 Try again later');
});

test('the password never appears, even when a host repeats what it was sent', () => {
  const password = 'pässwörd';
  const utf8 = (text: string) =>
    btoa(Array.from(new TextEncoder().encode(text), (byte) => String.fromCharCode(byte)).join(''));
  const plain = utf8(`\0me@example.com\0${password}`);
  const said = signInFailure(
    {
      authenticationFailed: true,
      response: `NO LOGIN me@example.com ${password}, or ${utf8(password)}, or AUTH PLAIN ${plain}`,
    },
    imap,
    { user: 'me@example.com', by: 'password', secrets: [password] },
  );
  expect(said).toBe(
    'imap.example.com refused the password: NO LOGIN me@example.com …, or …, or AUTH PLAIN …',
  );
});

test('a refused token is the sign-in refused, and no token appears, in XOAUTH2’s encoding either', () => {
  const token = 'eyJ0b2tlbiI6InNlY3JldCJ9';
  const xoauth2 = btoa(`user=me@example.com\x01auth=Bearer ${token}\x01\x01`);
  expect(
    signInFailure({ authenticationFailed: true, response: `NO ${xoauth2} and ${token}` }, imap, {
      user: 'me@example.com',
      by: 'token',
      secrets: ['an-older-token', token],
    }),
  ).toBe('imap.example.com refused the sign-in: NO … and …');
  expect(
    signInFailure({ code: 'EAUTH' }, smtp, { user: 'me@example.com', by: 'token', secrets: [] }),
  ).toBe('smtp.example.com refused the sign-in.');
});
