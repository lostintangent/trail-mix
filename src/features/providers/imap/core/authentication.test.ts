import { expect, test } from 'bun:test';
import { isVerified } from './authentication.ts';

const ZOHO = ['mx.zohomail.com'];
const FROM = 'news@example.com';
/** A header block, as a fetch of a message's header fields returns it, one line per header. */
const block = (...lines: string[]) => lines.map((line) => `${line}\r\n`).join('');
const passed =
  'Authentication-Results: mx.zohomail.com;\r\n\tdkim=pass;\r\n\tspf=pass (zohomail.com: domain of example.com designates 192.0.2.1 as permitted sender)  smtp.mailfrom=bounce@example.com;\r\n\tdmarc=pass(p=reject dis=none)  header.from=example.com';

test('the account’s own server, writing first, vouches for mail whose DMARC passed for its From', () => {
  expect(isVerified(block(passed, 'References: <a@example.com>'), ZOHO, FROM)).toBe(true);
  expect(isVerified(block(passed), ZOHO, 'NEWS@Example.COM')).toBe(true);
});

test('a header a sender wrote below the server’s is never read', () => {
  const failed =
    'Authentication-Results: mx.zohomail.com; dkim=none; dmarc=fail header.from=example.com';
  expect(isVerified(block(failed, passed), ZOHO, FROM)).toBe(false);
});

test('a header in any other server’s name, or with none, vouches for nothing', () => {
  const other = passed.replace('mx.zohomail.com;', 'mx.forged.example;');
  expect(isVerified(block(other), ZOHO, FROM)).toBe(false);
  // Microsoft's servers write theirs without a name of their own.
  const unnamed =
    'Authentication-Results: dkim=pass; dmarc=pass action=none header.from=example.com';
  expect(isVerified(block(unnamed), ZOHO, FROM)).toBe(false);
  // A server whose preset gives no name vouches for nothing, whatever it writes.
  expect(isVerified(block(passed), [], FROM)).toBe(false);
});

test('DMARC must pass for the From domain itself', () => {
  expect(isVerified(block(passed), ZOHO, 'news@mail.example.com')).toBe(false);
  expect(isVerified(block(passed), ZOHO, 'someone@example.org')).toBe(false);
  expect(isVerified(block(passed.replace('dmarc=pass', 'dmarc=fail')), ZOHO, FROM)).toBe(false);
  expect(isVerified(block(passed.replace('dmarc=pass', 'dmarc=none')), ZOHO, FROM)).toBe(false);
  // Passing DKIM or SPF alone isn't DMARC.
  const noDmarc =
    'Authentication-Results: mx.zohomail.com; dkim=pass header.d=example.com; spf=pass';
  expect(isVerified(block(noDmarc), ZOHO, FROM)).toBe(false);
  // A pass that names no From domain says nothing about this one.
  expect(isVerified(block('Authentication-Results: mx.zohomail.com; dmarc=pass'), ZOHO, FROM)).toBe(
    false,
  );
});

test('a comment can’t pass for a result, and a message with no header is unverified', () => {
  const commented =
    'Authentication-Results: mx.zohomail.com; dmarc=fail (dmarc=pass header.from=example.com) header.from=example.com';
  expect(isVerified(block(commented), ZOHO, FROM)).toBe(false);
  expect(isVerified(block('References: <a@example.com>'), ZOHO, FROM)).toBe(false);
  expect(isVerified('', ZOHO, FROM)).toBe(false);
  expect(isVerified(block(passed), ZOHO, '')).toBe(false);
});

test('a pass reads the From domain however its server writes it: quoted, or as the address', () => {
  for (const named of [
    '"example.com"',
    'news@example.com',
    '<news@example.com>',
    '"news@example.com"',
    'Example.COM.',
  ]) {
    const header = passed.replace('header.from=example.com', `header.from=${named}`);
    expect({ named, verified: isVerified(block(header), ZOHO, FROM) }).toEqual({
      named,
      verified: true,
    });
  }
  // An address at another domain is that domain's pass, not this one's.
  for (const named of [
    '<news@example.org>',
    'news@mail.example.com',
    'example.com@forged.example',
  ]) {
    const header = passed.replace('header.from=example.com', `header.from=${named}`);
    expect({ named, verified: isVerified(block(header), ZOHO, FROM) }).toEqual({
      named,
      verified: false,
    });
  }
});
