import { describe, expect, test } from 'bun:test';
import { foldQuote, isAttribution, quoteMarker } from './quotes.ts';

const lines = (...rows: string[]) => rows.join('\n');

describe('plain text', () => {
  test('a reply folds the quote below it, with its attribution', () => {
    const mail = lines(
      'Sounds good, see you there.',
      '',
      'On Mon, Nov 9, 2026 at 10:00 AM Ada Park <ada@example.com> wrote:',
      '> Lunch on Thursday?',
      '>',
      '> Ada',
    );
    expect(foldQuote(mail)).toEqual({
      text: 'Sounds good, see you there.',
      quote: lines(
        'On Mon, Nov 9, 2026 at 10:00 AM Ada Park <ada@example.com> wrote:',
        '> Lunch on Thursday?',
        '>',
        '> Ada',
      ),
    });
  });

  test('an attribution wrapped over two lines folds whole', () => {
    const mail = lines(
      'Yes.',
      '',
      'On Mon, Nov 9, 2026 at 10:00 AM Ada Park <',
      'ada@example.com> wrote:',
      '> Lunch?',
    );
    expect(foldQuote(mail).text).toBe('Yes.');
  });

  test('a blank line between the attribution and the quote still folds both', () => {
    const mail = lines('Yes.', '', 'On Nov 9, 2026, at 10:00, Ada wrote:', '', '> Lunch?', '');
    expect(foldQuote(mail)).toEqual({
      text: 'Yes.',
      quote: lines('On Nov 9, 2026, at 10:00, Ada wrote:', '', '> Lunch?', ''),
    });
  });

  test('a quote without an attribution folds alone', () => {
    expect(foldQuote(lines('Yes.', '> Lunch?')).quote).toBe('> Lunch?');
  });

  test('answers written between quoted lines stay unfolded', () => {
    const mail = lines('> Thursday?', 'Yes.', '> Noon?', 'Better at one.');
    expect(foldQuote(mail)).toEqual({ text: mail, quote: '' });
  });

  test('after inline answers, only the quote that ends the message folds', () => {
    const mail = lines('> Thursday?', 'Yes.', '', '> Thanks,', '> Ada');
    expect(foldQuote(mail)).toEqual({
      text: lines('> Thursday?', 'Yes.'),
      quote: '> Thanks,\n> Ada',
    });
  });

  test('a message that is nothing but a quote is shown whole', () => {
    const mail = lines('On Monday, Ada wrote:', '> Lunch?');
    expect(foldQuote(mail).quote).toBe('');
  });

  test('a forward is the point of its message and never folds', () => {
    const mail = lines(
      'FYI',
      '',
      '---------- Forwarded message ---------',
      'From: Ada Park <ada@example.com>',
      'Date: Mon, Nov 9, 2026 at 10:00 AM',
      '',
      'Lunch?',
    );
    expect(foldQuote(mail).quote).toBe('');
  });

  test("Outlook's original below a separator folds from the separator", () => {
    const mail = lines(
      'Thanks!',
      '',
      '________________________________',
      'From: Ada Park <ada@example.com>',
      'Sent: Monday, November 9, 2026 10:00 AM',
      'To: Jonas <jonas@example.com>',
      'Subject: Lunch',
      '',
      'Lunch on Thursday?',
    );
    expect(foldQuote(mail).text).toBe('Thanks!');
    expect(foldQuote(mail).quote).toStartWith('________________________________');
  });

  test("Outlook's header block folds even without a separator", () => {
    const mail = lines(
      'Thanks!',
      '',
      'From: Ada Park <ada@example.com>',
      'Sent: Monday, November 9, 2026 10:00 AM',
      'Subject: Lunch',
      '',
      'Lunch on Thursday?',
    );
    expect(foldQuote(mail).text).toBe('Thanks!');
  });

  test('a message that ends in its own words is unchanged', () => {
    const mail = lines('From: the desk of Ada', 'Lunch on Thursday?');
    expect(foldQuote(mail)).toEqual({ text: mail, quote: '' });
  });

  test('Windows line endings fold the same way', () => {
    expect(foldQuote('Yes.\r\nOn Monday, Ada wrote:\r\n> Lunch?').text).toBe('Yes.');
  });
});

describe('HTML quote markers', () => {
  const element = (traits: Partial<Parameters<typeof quoteMarker>[0]>) =>
    quoteMarker({ tag: 'div', id: '', className: '', type: '', ...traits });

  test('a cited blockquote is a quote, but a blockquote used for emphasis is not', () => {
    expect(element({ tag: 'blockquote', type: 'cite' })).toBe('quote');
    expect(element({ tag: 'blockquote', type: 'CITE' })).toBe('quote');
    expect(element({ tag: 'blockquote' })).toBeNull();
  });

  test("clients' quote containers are recognized among other classes", () => {
    expect(element({ className: 'gmail_quote gmail_quote_container' })).toBe('quote');
    expect(element({ className: 'note zmail_extra' })).toBe('quote');
    expect(element({ className: 'gmail_quoted' })).toBeNull();
  });

  test("Outlook's reply header folds everything after it, even when Outlook re-quotes it", () => {
    expect(element({ id: 'divRplyFwdMsg' })).toBe('rest');
    expect(element({ id: 'x_divRplyFwdMsg' })).toBe('rest');
    expect(element({ className: 'x_gmail_quote' })).toBe('quote');
  });
});

describe('attributions', () => {
  test('are recognized in the languages mail clients write them in', () => {
    expect(isAttribution('On Mon, Nov 9, 2026 at 10:00 AM Ada <ada@example.com> wrote:')).toBe(
      true,
    );
    expect(isAttribution('Am 09.11.2026 um 10:00 schrieb Ada <ada@example.com>:')).toBe(true);
    expect(isAttribution('Le lun. 9 nov. 2026 à 10:00, Ada <ada@example.com> a écrit :')).toBe(
      true,
    );
    expect(isAttribution('W dniu 9.11.2026 o 10:00 Ada <ada@example.com> napisał(a):')).toBe(true);
    expect(isAttribution('---- On Mon, 09 Nov 2026 10:00:00 +0000 Ada wrote ---')).toBe(true);
    expect(isAttribution('From: Ada Park Sent: Monday, November 9, 2026 To: Jonas')).toBe(true);
  });

  test('ordinary sentences are not attributions', () => {
    expect(isAttribution('Here is the plan for Thursday.')).toBe(false);
    expect(isAttribution('From: the desk of Ada')).toBe(false);
    expect(isAttribution(`${'A long paragraph. '.repeat(30)}Then someone wrote:`)).toBe(false);
  });
});
