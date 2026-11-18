import { expect, test } from 'bun:test';
import { nestedHtml, scopedCss } from './nesting.ts';

const scope = 'trailmix-forwarded';

test('a message’s document becomes its root holding its body, with what the body showed', () => {
  expect(
    nestedHtml(
      '<html dir="rtl" lang="ar" onload="x()"><head><meta charset=utf-8><base href="https://x/"><link rel=stylesheet href=a.css></head>' +
        '<body text="#333" style="margin: 0" onload="y()" id="b">שלום</body></html>',
      scope,
    ),
  ).toEqual({
    html: '<div class="trailmix-forwarded" dir="rtl" lang="ar"><div id="b" style="color: #333; margin: 0">שלום</div></div>',
    css: '',
  });
});

test('a style element’s media becomes its sheet’s, and every sheet is scoped wherever it was', () => {
  expect(
    nestedHtml('<style media="print">p { color: red }</style><p>Hi</p><style>td{}</style>', scope)
      .css,
  ).toBe('@media print {.trailmix-forwarded p { color: red }}\n.trailmix-forwarded td {}');
});

test('a head that starts once the body has shown something is no head, so what follows still shows', () => {
  expect(nestedHtml('<p>Hi</p><head><b>there</b>', scope).html).toContain('<p>Hi</p><b>there</b>');
  expect(nestedHtml('<head><title>T</title></head>Hello <b>you</b>', scope).html).toContain(
    '>Hello <b>you</b></div>',
  );
});

test('nothing the original leaves unended reaches past it', () => {
  expect(nestedHtml('<p>Hi</p><a href="https://x', scope).html).toBe(
    '<div class="trailmix-forwarded"><div><p>Hi</p></div></div>',
  );
  expect(nestedHtml('<p>Hi</p><!-- and', scope).html).toBe(
    '<div class="trailmix-forwarded"><div><p>Hi</p></div></div>',
  );
  expect(nestedHtml('<textarea>Hi', scope).html).toBe(
    '<div class="trailmix-forwarded"><div><textarea>Hi</textarea></div></div>',
  );
});

test('a sheet can’t end the style element that holds it', () => {
  const { css } = nestedHtml('<style>a</style{} <style> body { display: none }</style>', scope);
  expect(css).not.toMatch(/<\/style/i);
});

test('a style sheet scoped to the original reaches nothing outside it', () => {
  expect(
    scopedCss(
      [
        '<!-- html, body { margin: 0 } -->',
        ':root { --ink: #111 }',
        'html > body.dark .card, table td:is(.a, .b) { color: var(--ink) }',
        '* { box-sizing: border-box }',
        '@import url("https://x/a.css");',
        '@charset "utf-8";',
        '@font-face { font-family: X; src: url(x.woff) }',
        '@media screen and (max-width: 600px) { body { padding: 0 } @supports (display: grid) { .g { display: grid } } }',
        '@-moz-document url-prefix() { .x { color: red } }',
        '.a[title="{ }"]::after { content: "}" }',
        '/* a comment */ .b{}',
      ].join('\n'),
      '.trailmix-forwarded',
    ),
  ).toBe(
    [
      '.trailmix-forwarded, .trailmix-forwarded > div { margin: 0 }',
      '.trailmix-forwarded { --ink: #111 }',
      '.trailmix-forwarded > div.dark .card, .trailmix-forwarded table td:is(.a, .b) { color: var(--ink) }',
      '.trailmix-forwarded * { box-sizing: border-box }',
      '@font-face { font-family: X; src: url(x.woff) }',
      '@media screen and (max-width: 600px) {.trailmix-forwarded > div { padding: 0 }\n@supports (display: grid) {.trailmix-forwarded .g { display: grid }}}',
      '.trailmix-forwarded .a[title="{ }"]::after { content: "}" }',
      '.trailmix-forwarded .b {}',
    ].join('\n'),
  );
});
