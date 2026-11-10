import { describe, expect, test } from 'bun:test';
import { previewOf } from './preview.ts';

const plain = (...lines: string[]) => previewOf(lines.join('\r\n'), false);

describe('a preview', () => {
  test('leaves out quoted lines and folds whitespace', () => {
    expect(plain('Sounds good.', '', 'On Monday, Ada wrote:', '> Lunch?', '>   Friday')).toBe(
      'Sounds good. On Monday, Ada wrote:',
    );
  });

  test('stops at 200 characters', () => {
    expect(previewOf('word '.repeat(100), false)).toHaveLength(200);
  });
});

describe('a preview of plain text a sender made from its HTML', () => {
  test('reads a receipt’s logo, rule, heading and table as their words', () => {
    expect(
      plain(
        'Receipt from Cascade Ferry Co.',
        '',
        '![Logo](https://cdn.example.com/logo.png)',
        '',
        '************************************',
        '',
        '## Your receipt',
        '',
        '| Item | Qty | Price |',
        '|---|:---:|---:|',
        '| Crossing | 2 | $90.00 |',
      ),
    ).toBe('Receipt from Cascade Ferry Co. Logo Your receipt Item Qty Price Crossing 2 $90.00');
  });

  test('reads a layout table’s bars and a heading with no space after its marks as words', () => {
    expect(
      plain(
        '|  ',
        '---|---  ',
        '|  ##Hi Ada Park,',
        '',
        'Thank you so much for booking! We’re looking forward to seeing you.',
      ),
    ).toBe('Hi Ada Park, Thank you so much for booking! We’re looking forward to seeing you.');
  });

  test('keeps a space where an alt text or a cell ended', () => {
    expect(plain('[image: Acme]Welcome to Acme')).toBe('Acme Welcome to Acme');
    expect(plain('![Acme](https://acme.example/a.png)Welcome')).toBe('Acme Welcome');
    expect(plain('Order|Shipped|Today')).toBe('Order Shipped Today');
  });

  test('leaves out a link’s address written after its words, and keeps one written in the text', () => {
    expect(plain('View this email in your browser (https://mailchi.mp/acme/spring-sale)')).toBe(
      'View this email in your browser',
    );
    expect(plain('Read it online <https://news.example.com/42>', 'Hello')).toBe(
      'Read it online Hello',
    );
    expect(
      plain('[Acme](https://www.acme.example/) [Explore the collection](https://www.acme'),
    ).toBe('Acme Explore the collection');
    expect(plain('Your invoice: https://billing.example.com/7 is ready')).toBe(
      'Your invoice: https://billing.example.com/7 is ready',
    );
  });

  test('leaves out rules drawn in any mark, on their own line or inside one', () => {
    for (const rule of [
      '=====',
      '-----',
      '_____',
      '* * *',
      '~~~~',
      '———',
      '+----+----+',
      '#####',
    ]) {
      expect({ rule, preview: plain('Above', rule, 'Below') }).toEqual({
        rule,
        preview: 'Above Below',
      });
    }
    expect(plain('Total ************ $45.00')).toBe('Total $45.00');
  });

  test('leaves out the invisible padding newsletters put after their first line', () => {
    expect(plain('Your order shipped\u200c\u00a0\u200c\u00a0\u034f\u200c\u00a0Track it')).toBe(
      'Your order shipped Track it',
    );
    expect(plain('An extra\u00adordinary day')).toBe('An extraordinary day');
    // A joiner holds an emoji together, so it stays.
    expect(plain('\u{1F469}\u200d\u{1F4BB} shipped it')).toBe(
      '\u{1F469}\u200d\u{1F4BB} shipped it',
    );
  });
});

describe('a preview of Markdown, as mail from Trail Mix is written', () => {
  test('reads code, emphasis, links and lists as their words', () => {
    expect(plain('Thanks for `everything`!!!')).toBe('Thanks for everything!!!');
    expect(plain('**Bold**, *italic*, _also_, __strong__ and ~~gone~~.')).toBe(
      'Bold, italic, also, strong and gone.',
    );
    expect(plain('[The plan](https://example.com/plan) is ready.')).toBe('The plan is ready.');
    expect(plain('Bring:', '- milk', '* eggs', '+ bread', '1. First, the ferry')).toBe(
      'Bring: milk eggs bread 1. First, the ferry',
    );
  });

  test('keeps marks that emphasize nothing, and ones written with a backslash', () => {
    expect(plain('2 * 3 * 4 = 24, in snake_case_name, on #general, in C#')).toBe(
      '2 * 3 * 4 = 24, in snake_case_name, on #general, in C#',
    );
    expect(plain('1\\. Not a list, \\*not emphasis\\*, and a \\| bar')).toBe(
      '1. Not a list, *not emphasis*, and a | bar',
    );
  });
});

describe('a preview of HTML', () => {
  test('reads HTML as text: no head, styles, scripts or quotes, and entities decoded', () => {
    const page =
      '<html><head><title>Hi</title><style>p{color:red}</style></head><body>' +
      '<p>Fish &amp; chips&nbsp;at&#32;noon&#x21;</p><blockquote>old reply</blockquote><script>x()</script>' +
      '<p>See you</p></body></html>';
    expect(previewOf(page, true)).toBe('Fish & chips at noon! See you');
  });

  test('keeps a markup character that starts no tag', () => {
    expect(previewOf('<p>2 &lt; 3 and 3 > 2</p>', true)).toBe('2 < 3 and 3 > 2');
  });

  test('decodes the punctuation newsletters write as entities, and leaves out their padding', () => {
    const page =
      '<div style="display:none">It&rsquo;s here&hellip;' +
      '&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&#847;&zwnj;&nbsp;</div>' +
      '<p>**********</p><p>&ldquo;Spring&rdquo; &mdash; 20% off</p>';
    expect(previewOf(page, true)).toBe('It’s here… “Spring” — 20% off');
  });

  test('keeps Markdown’s marks, since HTML shows them as written', () => {
    expect(previewOf('<p>Use **bold** for `code`</p>', true)).toBe('Use **bold** for `code`');
  });
});
