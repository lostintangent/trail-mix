import { expect, test } from 'bun:test';
import { contentIdsIn, renderMarkdown } from './markdown.ts';

const STYLED = /^(p|h[1-6]|blockquote|pre|code|ul|ol|li|table|th|td|hr|img)$/;
const TAGS = new Set(['div', 'p', 'br', 'em', 'strong', 'del', 'a', 'thead', 'tbody', 'tr']);
const ADDRESSES = /^(https?:\/\/|mailto:|tel:|cid:)/i;

/** Every tag in some HTML, with its attributes, read strictly: anything else is a stray `<`. */
function tagsIn(html: string) {
  const tags: { name: string; closing: boolean; attributes: Map<string, string> }[] = [];
  const rest = html.replace(
    /<(\/?)([a-z][a-z0-9]*)((?:\s+[a-z]+="[^"<>]*")*)\s*>/g,
    (_, slash: string, name: string, attributes: string) => {
      tags.push({
        name,
        closing: slash === '/',
        attributes: new Map(
          [...attributes.matchAll(/([a-z]+)="([^"]*)"/g)].map(([, key, value]) => [key!, value!]),
        ),
      });
      return '';
    },
  );
  return { tags, stray: rest.includes('<') || rest.includes('>') };
}

/** Whether the HTML has only the tags and attributes the renderer writes, every one styled. */
function wellFormed(html: string) {
  const { tags, stray } = tagsIn(html);
  expect(stray).toBe(false);
  for (const { name, attributes } of tags) {
    expect(STYLED.test(name) || TAGS.has(name)).toBe(true);
    for (const [key, value] of attributes) {
      expect(['style', 'href', 'src', 'alt', 'title', 'start']).toContain(key);
      if (key === 'href' || key === 'src') expect(value).toMatch(ADDRESSES);
    }
  }
}

test('every block and inline element the Markdown makes carries its own style', () => {
  const html = renderMarkdown(
    [
      '# One',
      '## Two',
      '### Three',
      '#### Four',
      'A paragraph with `code`.',
      '> A quote',
      '- a\n- b',
      '1. one\n2. two',
      '```\ncode\n```',
      '| a | b |\n|---|---|\n| 1 | 2 |',
      '---',
      '![A pasted image](cid:pasted@trailmix.invalid)',
    ].join('\n\n'),
    new Set(['pasted@trailmix.invalid']),
  );
  const opened = tagsIn(html).tags.filter(({ name, closing }) => !closing && STYLED.test(name));
  expect(new Set(opened.map(({ name }) => name))).toEqual(
    new Set(['h1', 'h2', 'h3', 'h4', 'p', 'code', 'blockquote', 'ul', 'ol', 'li', 'pre', 'table'])
      .add('th')
      .add('td')
      .add('hr')
      .add('img'),
  );
  for (const { attributes } of opened) expect(attributes.get('style')).toBeTruthy();
  wellFormed(html);
  expect(html).not.toMatch(/color|background/);
});

test('the HTML says what the Markdown says', () => {
  const html = renderMarkdown(
    [
      'Some **bold**, *emphasis* and ~~struck~~ text.',
      '3. three\n4. four',
      '- [ ] open\n- [x] done',
      '| left | right |\n|:-----|------:|\n| 1 | 2 |',
    ].join('\n\n'),
  );
  expect(html).toContain('<strong>bold</strong>, <em>emphasis</em> and <del>struck</del>');
  expect(html).toMatch(/<ol start="3"[^>]*>\s*<li[^>]*>three<\/li>\s*<li[^>]*>four<\/li>/);
  expect(html).toMatch(/<li[^>]*>☐ open<\/li>\s*<li[^>]*>☑ done<\/li>/);
  expect(html).toMatch(/<th style="[^"]*text-align: left[^"]*">left<\/th>/);
  expect(html).toMatch(/<td style="[^"]*text-align: right[^"]*">2<\/td>/);
});

test('a line break is a break, as it is in the plain-text part', () => {
  expect(renderMarkdown('Thanks,\nAda')).toContain('Thanks,<br>Ada');
});

test('a signature keeps its delimiter line', () => {
  expect(renderMarkdown('See you then.\n\n-- \nAda')).toContain(
    '<p style="margin: 0 0 1em">--<br>Ada</p>',
  );
});

test('code shows the characters it holds', () => {
  const html = renderMarkdown('Use `a < b && c > "d"`.\n\n```ts\nif (a < b) return "<b>";\n```');
  expect(html).toContain('a &#60; b &#38;&#38; c &#62; &#34;d&#34;');
  expect(html).toMatch(/<code [^>]*>if \(a &#60; b\) return &#34;&#60;b&#62;&#34;;<\/code><\/pre>/);
});

test('raw HTML shows as the text it is', () => {
  const html = renderMarkdown(
    '<div onclick="steal()">Hi</div>\n\nAn inline <b>tag</b> and <script>x</script>.',
  );
  expect(html).toContain('&#60;div onclick=&#34;steal()&#34;&#62;Hi&#60;/div&#62;');
  expect(html).toContain(
    'An inline &#60;b&#62;tag&#60;/b&#62; and &#60;script&#62;x&#60;/script&#62;.',
  );
  wellFormed(html);
});

test('a link a recipient can follow keeps its address, and any other is its text', () => {
  const html = renderMarkdown(
    [
      '[web](https://example.com/a?b=1&c=2 "A title")',
      '[mail](mailto:ada@example.com)',
      '[call](tel:+15551234)',
      'www.example.org and ada@example.com',
      '[script](javascript:alert(1))',
      '[data](data:text/html,<b>x</b>)',
      '[file](file:///etc/passwd)',
      '[relative](/inbox)',
    ].join('\n\n'),
  );
  expect(html).toContain('<a href="https://example.com/a?b=1&#38;c=2" title="A title">web</a>');
  expect(html).toContain('<a href="mailto:ada@example.com">mail</a>');
  expect(html).toContain('<a href="tel:+15551234">call</a>');
  expect(html).toContain('<a href="http://www.example.org">www.example.org</a>');
  expect(html).toContain('<a href="mailto:ada@example.com">ada@example.com</a>');
  for (const text of ['script', 'data', 'file', 'relative']) {
    expect(html).toContain(`<p style="margin: 0 0 1em">${text}</p>`);
  }
  wellFormed(html);
});

test('an image on the web or carried by the message shows', () => {
  const html = renderMarkdown(
    '![A chart](https://example.com/chart.png "Q3") ![The ridge](cid:ridge%40trailmix.invalid)',
    new Set(['ridge@trailmix.invalid']),
  );
  expect(html).toContain(
    '<img src="https://example.com/chart.png" alt="A chart" title="Q3" style="max-width: 100%; height: auto">',
  );
  expect(html).toContain('<img src="cid:ridge%40trailmix.invalid" alt="The ridge"');
});

test('an image the message does not carry fails the render, naming it', () => {
  expect(() => renderMarkdown('![The ridge](cid:ridge@trailmix.invalid)')).toThrow(
    'The image "The ridge" is the attachment ridge@trailmix.invalid, which the message doesn\'t carry.',
  );
  expect(() => renderMarkdown('![Pasted](data:image/png;base64,AAAA)')).toThrow(
    'The image "Pasted" is at data:image/png;base64,AAAA, which is neither an attachment nor on the web.',
  );
  expect(() => renderMarkdown('![Local](photo.png)')).toThrow(
    'neither an attachment nor on the web',
  );
});

test('hostile Markdown renders to only the tags and addresses the renderer writes', () => {
  const hostile = [
    '<img src=x onerror=alert(1)>',
    '<a href="javascript:alert(1)">x</a>',
    '[x](JaVaScRiPt:alert(1))',
    '[x](jav&#x61;script:alert(1))',
    '[x]( javascript:alert(1))',
    '<javascript:alert(1)>',
    '[x](https://example.com/"onmouseover="alert(1))',
    '[x](https://example.com "a\\" onmouseover=\\"alert(1)")',
    '![x" onerror="alert(1)](https://example.com/a.png)',
    '<style>p{color:red}</style>',
    '<!-- <script>alert(1)</script> -->',
    '`<script>`',
    '<iframe src="https://example.com"></iframe>',
    '| <b>x</b> |\n|---|\n| <i>y</i> |',
    '> <svg onload=alert(1)>',
    '- <math><mtext><table><mglyph><style><img src=x onerror=alert(1)>',
  ];
  for (const markdown of hostile) wellFormed(renderMarkdown(markdown));
  wellFormed(renderMarkdown(hostile.join('\n\n')));
});

test('the images a Markdown shows by cid: are listed decoded, in order, each once', () => {
  expect(
    contentIdsIn(
      [
        '![a](cid:one%40trailmix.invalid) ![b](https://example.com/b.png)',
        '[not an image](cid:link@trailmix.invalid)',
        '> ![c](cid:two@trailmix.invalid) ![a again](cid:one@trailmix.invalid)',
        '`![code](cid:code@trailmix.invalid)`',
      ].join('\n\n'),
    ),
  ).toEqual(['one@trailmix.invalid', 'two@trailmix.invalid']);
});
