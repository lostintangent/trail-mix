import { describe, expect, test } from 'bun:test';
import { isVerified, oneClickUnsubscribe } from './authentication.ts';

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

describe('one-click unsubscribe', () => {
  const ADDRESS = 'https://github.com/notifications/unsubscribe/abc';
  const signature = (domain: string, b: string, signs: string) =>
    `DKIM-Signature: v=1; a=rsa-sha256; c=relaxed/relaxed; d=${domain};\r\n\ts=pf2023; t=1700000000;\r\n\th=${signs};\r\n\tbh=47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=;\r\n\tb=${b.slice(0, 20)}\r\n\t ${b.slice(20)}`;
  const BOTH = 'Date:From:To:Subject:List-ID:List-Unsubscribe:\r\n\t List-Unsubscribe-Post';
  const offer = ({
    results = 'mx.zohomail.com;\r\n\tdkim=pass;\r\n\tdmarc=pass header.from=github.com',
    signatures = [signature('github.com', 'Gh0bYtHGdA8xSc4mGs1MfbxL9QXbQWjYqgGnCd5vRhM=', BOTH)],
    from = 'From: Mona <notifications@github.com>',
    unsubscribe = [`List-Unsubscribe: <mailto:leave@github.com>, <${ADDRESS}>`],
    post = ['List-Unsubscribe-Post: List-Unsubscribe=One-Click'],
  }: {
    results?: string;
    signatures?: string[];
    from?: string;
    unsubscribe?: string[];
    post?: string[];
  } = {}) =>
    block(
      `Authentication-Results: ${results}`,
      ...signatures,
      from,
      'To: rae@trailmix.test',
      'Subject: [trail-mix] Review requested',
      'List-ID: trail-mix <trail-mix.lostintangent.github.com>',
      ...unsubscribe,
      ...post,
    );
  const qualifies = (message: string) => oneClickUnsubscribe(message, ['mx.zohomail.com']);

  test('a verified offer, both of whose headers a passing signature covers, gives its address', () => {
    expect(qualifies(offer())).toBe(ADDRESS);
    // A whole message gives the same, whatever its body says after the header ends.
    const body = '\r\nList-Unsubscribe: <https://forged.example/>\r\n';
    expect(qualifies(`${offer()}${body}`)).toBe(ADDRESS);
  });

  test('the server’s own word is what verifies it, as for any message', () => {
    const failed = 'mx.zohomail.com; dkim=pass; dmarc=fail header.from=github.com';
    expect(qualifies(offer({ results: failed }))).toBeUndefined();
    const elsewhere = 'mx.forged.example; dkim=pass; dmarc=pass header.from=github.com';
    expect(qualifies(offer({ results: elsewhere }))).toBeUndefined();
    expect(oneClickUnsubscribe(offer(), [])).toBeUndefined();
    // A sender's own header below the server's is never read.
    const below = block(
      'Authentication-Results: mx.zohomail.com; dkim=none; dmarc=fail header.from=github.com',
      offer(),
    );
    expect(qualifies(below)).toBeUndefined();
    // A From with two addresses, or two Froms, names no one sender to verify.
    expect(
      qualifies(offer({ from: 'From: notifications@github.com, rae@trailmix.test' })),
    ).toBeUndefined();
    expect(
      qualifies(
        offer({ from: 'From: notifications@github.com\r\nFrom: notifications@github.com' }),
      ),
    ).toBeUndefined();
  });

  test('a signature the server found passing has to cover both list headers', () => {
    for (const results of [
      'mx.zohomail.com; dkim=fail; dmarc=pass header.from=github.com',
      'mx.zohomail.com; dkim=none; dmarc=pass header.from=github.com',
      'mx.zohomail.com; dkim=fail (dkim=pass) header.d=github.com; dmarc=pass header.from=github.com',
    ]) {
      expect({ results, address: qualifies(offer({ results })) }).toEqual({
        results,
        address: undefined,
      });
    }
    for (const signs of [
      'From:To:Subject',
      'From:List-Unsubscribe',
      'From:List-Unsubscribe-Post',
    ]) {
      const signatures = [signature('github.com', 'Gh0bYtHGdA8xSc4mGs1MfbxL9QXbQWjYq', signs)];
      expect({ signs, address: qualifies(offer({ signatures })) }).toEqual({
        signs,
        address: undefined,
      });
    }
    expect(qualifies(offer({ signatures: [] }))).toBeUndefined();
    // However the signer folds and cases its list of headers.
    const folded = 'from : list-UNSUBSCRIBE :\r\n\t LIST-unsubscribe-post';
    expect(
      qualifies(offer({ signatures: [signature('github.com', 'Gh0bYtHGdA8xSc4mGs1Mf', folded)] })),
    ).toBe(ADDRESS);
  });

  test('a pass that names its signature is held to that signature alone', () => {
    const relay = signature('amazonses.com', 'Rel4yS1gnatureBytesXyZ0123456789', 'From:To:Subject');
    const github = signature('github.com', 'Gh0bYtHGdA8xSc4mGs1MfbxL9QXbQWjYq', BOTH);
    const named = (d: string, b?: string) =>
      offer({
        signatures: [relay, github],
        results: `mx.zohomail.com; dkim=pass header.d=${d}${b ? ` header.b="${b}"` : ''}; dmarc=pass header.from=github.com`,
      });
    expect(qualifies(named('github.com'))).toBe(ADDRESS);
    expect(qualifies(named('amazonses.com'))).toBeUndefined();
    // Unnamed, the pass may be the relay's, which signs neither list header.
    expect(qualifies(offer({ signatures: [relay, github] }))).toBeUndefined();
    // Two signatures from one domain are told apart by the start of their signatures.
    const older = signature('github.com', 'OldSigNatureBytesQwErTy0123456789', 'From:To:Subject');
    const twins = (b: string) =>
      offer({
        signatures: [older, github],
        results: `mx.zohomail.com; dkim=pass header.d=github.com header.b=${b}; dmarc=pass header.from=github.com`,
      });
    expect(qualifies(twins('Gh0bYtHG'))).toBe(ADDRESS);
    expect(qualifies(twins('OldSigNa'))).toBeUndefined();
  });

  test('the post has to say One-Click, once', () => {
    for (const post of [
      [],
      ['List-Unsubscribe-Post: List-Unsubscribe=One-Click-Later'],
      ['List-Unsubscribe-Post: list-unsubscribe=one-click'],
      [
        'List-Unsubscribe-Post: List-Unsubscribe=One-Click',
        'List-Unsubscribe-Post: List-Unsubscribe=One-Click',
      ],
    ]) {
      expect({ post, address: qualifies(offer({ post })) }).toEqual({ post, address: undefined });
    }
  });

  test('the offer holds exactly one HTTPS address, which can carry no sign-in', () => {
    for (const unsubscribe of [
      [],
      ['List-Unsubscribe: <mailto:leave@github.com>'],
      ['List-Unsubscribe: <http://github.com/unsubscribe>'],
      [`List-Unsubscribe: <http://github.com/unsubscribe>, <${ADDRESS}>`],
      [`List-Unsubscribe: <${ADDRESS}>, <https://github.com/unsubscribe/other>`],
      [`List-Unsubscribe: <${ADDRESS}>`, `List-Unsubscribe: <${ADDRESS}>`],
      ['List-Unsubscribe: <https://rae:secret@github.com/unsubscribe>'],
      [`List-Unsubscribe: ${ADDRESS}`],
      ['List-Unsubscribe: <https://>'],
    ]) {
      expect({ unsubscribe, address: qualifies(offer({ unsubscribe })) }).toEqual({
        unsubscribe,
        address: undefined,
      });
    }
    // Comments sit between the addresses, and whitespace inside the brackets is no part of one.
    const commented =
      'List-Unsubscribe: (Leave <https://forged.example/>) <https://github.com/notifications/\r\n\tunsubscribe/abc> (by mail:) <mailto:leave@github.com>';
    expect(qualifies(offer({ unsubscribe: [commented] }))).toBe(ADDRESS);
  });
});
