import { describe, expect, test } from 'bun:test';
import { rewriteCssResources } from './css.ts';

/** Resolves every resource to a marked copy, except those named `blocked…`, which load nothing. */
function rewrite(css: string): { css: string; asked: string[] } {
  const asked: string[] = [];
  const out = rewriteCssResources(css, (url) => {
    asked.push(url);
    return url.startsWith('blocked') ? null : `proxy/${url}`;
  });
  return { css: out, asked };
}

describe('url()', () => {
  test('every form of url() is resolved', () => {
    expect(rewrite('a{background:url(a.png)}').css).toBe('a{background:url("proxy/a.png")}');
    expect(rewrite('a{background:url("a.png")}').css).toBe('a{background:url("proxy/a.png")}');
    expect(rewrite("a{background:url('a.png')}").css).toBe('a{background:url("proxy/a.png")}');
    expect(rewrite('a{background:url(  a.png  )}').css).toBe('a{background:url("proxy/a.png")}');
  });

  test('a url that resolves to nothing becomes none', () => {
    expect(rewrite('a{background:#fff url(blocked.png) no-repeat}').css).toBe(
      'a{background:#fff none no-repeat}',
    );
  });

  test('case and escapes cannot hide url()', () => {
    for (const disguise of ['URL(', 'uRl(', 'u\\72l(', '\\75 rl(', '\\000075rl(', 'u\\rl(']) {
      const { asked } = rewrite(`a{background:${disguise}a.png)}`);
      expect(asked).toEqual(['a.png']);
    }
  });

  test('escapes inside the url are decoded before resolving', () => {
    expect(rewrite('a{background:url(\\68ttp://x/a.png)}').asked).toEqual(['http://x/a.png']);
    expect(rewrite('a{background:url("http\\3a //x/a.png")}').asked).toEqual(['http://x/a.png']);
  });

  test('a name that only ends in url is still treated as url()', () => {
    // A browser that splits the first character off would see url() here.
    expect(rewrite('a{background:\u00a0url(a.png)}').asked).toEqual(['a.png']);
  });

  test('a malformed url loads nothing and is never resolved', () => {
    for (const bad of ['url(a b.png)', 'url(a"b.png)', "url(a'b)", 'url(a(b)']) {
      const { css, asked } = rewrite(`a{background:${bad};color:red}`);
      expect(asked).toEqual([]);
      expect(css).toBe('a{background:none;color:red}');
    }
  });

  test('custom properties are rewritten like any other value', () => {
    expect(rewrite('a{--hero:url(a.png)}').css).toBe('a{--hero:url("proxy/a.png")}');
  });

  test('url() nested inside other functions is found', () => {
    expect(rewrite('a{background:linear-gradient(red,blue),url(a.png)}').asked).toEqual(['a.png']);
    expect(rewrite('a{mask:var(--m,url(a.png))}').asked).toEqual(['a.png']);
  });
});

describe('image functions', () => {
  test('strings inside image-set name images', () => {
    const { css } = rewrite('a{background-image:image-set("a.png" 1x, url(b.png) 2x)}');
    expect(css).toBe('a{background-image:image-set("proxy/a.png" 1x, url("proxy/b.png") 2x)}');
  });

  test('prefixed and other image functions are covered', () => {
    for (const fn of ['-webkit-image-set', 'image', 'cross-fade', 'src']) {
      expect(rewrite(`a{background:${fn}("a.png")}`).asked).toEqual(['a.png']);
    }
  });

  test('an image function with any unresolved image becomes none', () => {
    const { css } = rewrite('a{background-image:image-set("a.png" 1x, "blocked.png" 2x)}');
    expect(css).toBe('a{background-image:none}');
  });

  test('a type() string inside image-set is not mistaken for an image', () => {
    const { asked } = rewrite('a{background:image-set("a.avif" type("image/avif"))}');
    expect(asked).toEqual(['a.avif']);
  });
});

describe('what is not a resource', () => {
  test('url( inside a string or a comment is left alone', () => {
    const { css, asked } = rewrite('a{content:"url(a.png)"}/* url(b.png) */');
    expect(asked).toEqual([]);
    expect(css).toBe('a{content:"url(a.png)"}/* url(b.png) */');
  });

  test('a function merely containing url in its name before the end is left alone', () => {
    expect(rewrite('a{width:urlish(1px)}').asked).toEqual([]);
  });

  test('url followed by whitespace before the parenthesis is not a function', () => {
    expect(rewrite('a{background:url (a.png)}').asked).toEqual([]);
  });
});

describe('@import', () => {
  test('is dropped whole in every form', () => {
    for (const rule of [
      '@import url(a.css);',
      '@import "a.css";',
      '@IMPORT "a.css" screen;',
      '@\\69mport "a.css";',
      '@import url(a.css) layer(x) supports(display:grid);',
    ]) {
      const { css, asked } = rewrite(`${rule}a{color:red}`);
      expect(asked).toEqual([]);
      expect(css).toBe('a{color:red}');
    }
  });
});

describe('what comes out', () => {
  test('cannot close the style element it is written into', () => {
    const { css } = rewrite('a{content:"\\3c /style><img src=x>"}');
    expect(css).not.toContain('<');
  });

  test('a resolved url with quotes or newlines stays one string', () => {
    const out = rewriteCssResources('a{background:url(x)}', () => 'a"b\\c\nd');
    expect(out).toBe('a{background:url("a\\"b\\\\c\\a d")}');
  });

  test('CSS with no resources comes out as it went in', () => {
    const css = '@media (width < 600px){.a>.b{color:light-dark(#000,#fff);margin:0 auto}}';
    expect(rewrite(css).css).toBe(css);
  });

  test('a function’s name comes out as written, so an escaped url( in it stays part of the name', () => {
    const name = '\\75 rl\\28 https\\3a \\2f \\2f evil\\2e example\\2f t\\29 \\2c linear-gradient';
    const css = `a{--x:${name}(red,blue);background:var(--x)}`;
    const { css: out, asked } = rewrite(css);
    expect(out).toBe(css);
    expect(asked).toEqual([]);
    expect(rewrite('a{color:RGB(0,0,0);background:-WebKit-Image-Set("a.png" 1x)}').css).toBe(
      'a{color:RGB(0,0,0);background:-WebKit-Image-Set("proxy/a.png" 1x)}',
    );
  });
});
