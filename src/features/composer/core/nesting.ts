/**
 * A message's HTML made to sit inside another's, as a forward's original sits under its note. What
 * its body shows is kept as it was written, and so are its style sheets, but nothing that makes a
 * document: its doctype, its head, its scripts, and the elements that would change the page around
 * it. Its root and its body become two elements, the root holding the body, and each style sheet
 * is scoped to the root, so no rule reaches the note above it, and what a rule said of the page's
 * root or body it says of those two.
 *
 * Mail's HTML is often broken, so this reads it as tolerantly as a browser does, and keeps what it
 * can't make sense of as it was.
 */

export type Nested = {
  /** The root, holding the body, holding what the body showed. */
  html: string;
  /** Every style sheet, scoped to the root. */
  css: string;
};

/**
 * The HTML `html` as an element of class `scope` holding its body, and its style sheets scoped to
 * that element.
 */
export function nestedHtml(html: string, scope: string): Nested {
  const read = readDocument(html);
  const root = attributesOf(read.root, ['class', 'dir', 'lang']);
  const body = attributesOf(read.body, ['class', 'id', 'dir', 'lang']);
  const rootClass = [scope, root.class].filter(Boolean).join(' ');
  const style = [...presentational(read.body), read.body.get('style')]
    .filter((rule) => rule?.trim())
    .join('; ');
  const opened = (attributes: [string, string | undefined][]) =>
    attributes
      .filter((attribute): attribute is [string, string] => attribute[1] !== undefined)
      .map(([name, value]) => ` ${name}="${value.replace(/"/g, '&quot;')}"`)
      .join('');
  const rootTag = `<div${opened([
    ['class', rootClass],
    ['dir', root.dir],
    ['lang', root.lang],
  ])}>`;
  const bodyTag = `<div${opened([
    ['class', body.class],
    ['id', body.id],
    ['dir', body.dir],
    ['lang', body.lang],
    ['style', style || undefined],
  ])}>`;
  return {
    html: `${rootTag}${bodyTag}${read.content}</div></div>`,
    css: read.sheets.map((sheet) => scopedCss(sheet, `.${scope}`)).join('\n'),
  };
}

/**
 * A style sheet whose rules reach only `scope` and what is inside it. A selector of the page's root
 * or `:root` selects the scope, one of the body selects the scope's child, and every other selector
 * is read inside the scope. Rules in `@media`, `@supports`, `@container` and `@layer` are scoped
 * the same way. Fonts, keyframes and pages stay as they are. `@import` and every rule this doesn't
 * know are dropped, so no rule it can't scope is kept.
 */
export function scopedCss(css: string, scope: string): string {
  // A sheet's text can't end the style element that holds it, whatever a rule of it says.
  return rulesOf(css, 0, css.length, scope).replace(/<\/(?=style)/gi, '<\\/');
}

// Reading the document.

type Read = {
  content: string;
  sheets: string[];
  root: Map<string, string>;
  body: Map<string, string>;
};

/** Elements whose content is text up to their end tag, not markup. */
const RAW_TEXT = new Set([
  'style',
  'script',
  'title',
  'textarea',
  'xmp',
  'iframe',
  'noembed',
  'noframes',
]);

/** Elements that belong to a document's head, dropped wherever they are. */
const DOCUMENT = new Set(['meta', 'link', 'base']);

/** What a head may hold. Anything else ends it, as a browser reads it. */
const HEAD = new Set(['meta', 'link', 'base', 'title', 'style', 'script', 'noscript', 'template']);

function readDocument(html: string): Read {
  const read: Read = { content: '', sheets: [], root: new Map(), body: new Map() };
  let inHead = false;
  let at = 0;
  const keep = (text: string) => {
    if (inHead && /\S/.test(text.replace(/<!--[\s\S]*?-->/g, ''))) inHead = false;
    if (!inHead) read.content += text;
  };
  while (at < html.length) {
    const open = html.indexOf('<', at);
    if (open < 0) {
      keep(html.slice(at));
      break;
    }
    if (open > at) keep(html.slice(at, open));
    if (html.startsWith('<!--', open)) {
      const close = html.indexOf('-->', open + 4);
      // An unclosed comment hides the rest, as it would in a browser.
      if (close < 0) break;
      if (!inHead) read.content += html.slice(open, close + 3);
      at = close + 3;
      continue;
    }
    if (html[open + 1] === '!' || html[open + 1] === '?') {
      // A doctype, a processing instruction or a bogus comment, none of which shows.
      const close = html.indexOf('>', open);
      at = close < 0 ? html.length : close + 1;
      continue;
    }
    const tag = /^<(\/?)([a-zA-Z][^\s/>]*)/.exec(html.slice(open, open + 100));
    if (!tag) {
      keep('<');
      at = open + 1;
      continue;
    }
    const end = tagEnd(html, open + tag[0].length);
    // A tag the HTML never ends shows nothing, as in a browser, and kept it would hide what follows.
    if (end >= html.length) break;
    const name = tag[2]!.toLowerCase();
    const isEnd = tag[1] === '/';
    const attributes = isEnd ? '' : html.slice(open + tag[0].length, end);
    at = end + 1;
    if (!isEnd && RAW_TEXT.has(name)) {
      const closing = new RegExp(`</${name}[\\s/>]`, 'i').exec(html.slice(at));
      const textEnd = closing ? at + closing.index : html.length;
      const after = closing ? html.indexOf('>', textEnd) : -1;
      const text = html.slice(at, textEnd);
      // Ended, so it can't take what follows it as its text.
      const whole = after < 0 ? `${html.slice(open)}</${name}>` : html.slice(open, after + 1);
      at = after < 0 ? html.length : after + 1;
      if (name === 'style') read.sheets.push(withMedia(text, attributesIn(attributes)));
      else if (name !== 'script' && name !== 'title') keep(whole);
      continue;
    }
    if (name === 'html') {
      if (!isEnd && read.root.size === 0) read.root = attributesIn(attributes);
    } else if (name === 'head') {
      // A head begun once the body has shown something is no head, as a browser reads it.
      inHead = !isEnd && !/\S/.test(read.content);
    } else if (name === 'body') {
      inHead = false;
      if (!isEnd && read.body.size === 0) read.body = attributesIn(attributes);
    } else if (!DOCUMENT.has(name)) {
      if (inHead && !isEnd && !HEAD.has(name)) inHead = false;
      if (!inHead) read.content += html.slice(open, at);
    }
  }
  return read;
}

/** Where a tag that started before `from` ends: its `>`, past any quoted attribute value. */
function tagEnd(html: string, from: number): number {
  let afterEquals = false;
  for (let at = from; at < html.length; at++) {
    const char = html[at]!;
    if (char === '>') return at;
    if (afterEquals && (char === '"' || char === "'")) {
      const close = html.indexOf(char, at + 1);
      if (close < 0) return html.length;
      at = close;
      afterEquals = false;
    } else if (char === '=') {
      afterEquals = true;
    } else if (!/\s/.test(char)) {
      afterEquals = false;
    }
  }
  return html.length;
}

/** A tag's attributes, each by its lowercased name, valued as written. */
function attributesIn(text: string): Map<string, string> {
  const attributes = new Map<string, string>();
  for (const [, name, double, single, bare] of text.matchAll(
    /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g,
  )) {
    const key = name!.toLowerCase();
    if (!attributes.has(key)) attributes.set(key, double ?? single ?? bare ?? '');
  }
  return attributes;
}

function attributesOf<Name extends string>(
  attributes: Map<string, string>,
  names: readonly Name[],
): Partial<Record<Name, string>> {
  return Object.fromEntries(
    names
      .filter((name) => attributes.get(name)?.trim())
      .map((name) => [name, attributes.get(name)]),
  ) as Partial<Record<Name, string>>;
}

/** The body's look that HTML says with attributes, as CSS. */
function presentational(body: Map<string, string>): string[] {
  const rules: string[] = [];
  const background = body.get('bgcolor');
  const color = body.get('text');
  const image = body.get('background');
  if (background) rules.push(`background-color: ${background}`);
  if (color) rules.push(`color: ${color}`);
  if (image) rules.push(`background-image: url("${image.replace(/["\\]/g, '\\$&')}")`);
  return rules;
}

/** A style element's sheet, inside its media query if it has one. */
function withMedia(css: string, attributes: Map<string, string>): string {
  const media = attributes.get('media')?.trim();
  return media && media.toLowerCase() !== 'all' ? `@media ${media} {${css}}` : css;
}

// Scoping style sheets.

/** At-rules whose rules are scoped like the sheet's own. */
const GROUPING = new Set(['media', 'supports', 'container', 'layer', 'starting-style']);

/** At-rules that select nothing on the page, kept as they are. */
const KEPT = new Set([
  'font-face',
  'keyframes',
  '-webkit-keyframes',
  '-moz-keyframes',
  'page',
  'font-feature-values',
  'font-palette-values',
  'counter-style',
  'property',
]);

function rulesOf(css: string, from: number, to: number, scope: string): string {
  const rules: string[] = [];
  let at = from;
  while (at < to) {
    at = skipBetweenRules(css, at, to);
    if (at >= to) break;
    if (css[at] === '}') {
      at++;
      continue;
    }
    const prelude = preludeEnd(css, at, to);
    const text = css.slice(at, prelude).trim();
    if (prelude >= to || css[prelude] === ';') {
      // A statement: only a layer's order is kept, since nothing else of it scopes.
      if (/^@layer\b/i.test(text)) rules.push(`${text};`);
      at = prelude + 1;
      continue;
    }
    const close = blockEnd(css, prelude + 1, to);
    const block = css.slice(prelude + 1, close);
    at = close + 1;
    const keyword = /^@([\w-]+)/.exec(text)?.[1]?.toLowerCase();
    if (keyword === undefined) {
      const selectors = scopedSelectors(text, scope);
      if (selectors) rules.push(`${selectors} {${block}}`);
    } else if (GROUPING.has(keyword)) {
      rules.push(`${text} {${rulesOf(css, prelude + 1, close, scope)}}`);
    } else if (KEPT.has(keyword)) {
      rules.push(`${text} {${block}}`);
    }
  }
  return rules.join('\n');
}

/** Past whitespace, comments, and the `<!--` and `-->` old sheets hid themselves in. */
function skipBetweenRules(css: string, from: number, to: number): number {
  let at = from;
  for (;;) {
    while (at < to && /\s/.test(css[at]!)) at++;
    if (css.startsWith('/*', at)) {
      const close = css.indexOf('*/', at + 2);
      at = close < 0 || close + 2 > to ? to : close + 2;
    } else if (css.startsWith('<!--', at)) {
      at += 4;
    } else if (css.startsWith('-->', at)) {
      at += 3;
    } else {
      return at;
    }
  }
}

/** Where a rule's prelude ends: at its block's `{`, at a statement's `;`, or at `to`. */
function preludeEnd(css: string, from: number, to: number): number {
  let depth = 0;
  for (let at = from; at < to; at++) {
    const char = css[at]!;
    if (char === '\\') at++;
    else if (char === '"' || char === "'") at = stringEnd(css, at, to);
    else if (css.startsWith('/*', at)) at = commentEnd(css, at, to);
    else if (char === '(' || char === '[') depth++;
    else if (char === ')' || char === ']') depth = Math.max(0, depth - 1);
    else if (depth === 0 && (char === '{' || char === ';')) return at;
  }
  return to;
}

/** Where the block that opened before `from` closes: its `}`, or `to`. */
function blockEnd(css: string, from: number, to: number): number {
  let depth = 0;
  for (let at = from; at < to; at++) {
    const char = css[at]!;
    if (char === '\\') at++;
    else if (char === '"' || char === "'") at = stringEnd(css, at, to);
    else if (css.startsWith('/*', at)) at = commentEnd(css, at, to);
    else if (char === '{') depth++;
    else if (char === '}') {
      if (depth === 0) return at;
      depth--;
    }
  }
  return to;
}

function stringEnd(css: string, from: number, to: number): number {
  const quote = css[from];
  for (let at = from + 1; at < to; at++) {
    if (css[at] === '\\') at++;
    else if (css[at] === quote || css[at] === '\n') return at;
  }
  return to;
}

function commentEnd(css: string, from: number, to: number): number {
  const close = css.indexOf('*/', from + 2);
  return close < 0 || close + 1 >= to ? to : close + 1;
}

/** A selector list, each selector read inside `scope`. Empty when it holds none. */
function scopedSelectors(list: string, scope: string): string {
  return splitTopLevel(list, ',')
    .map((selector) => selector.trim())
    .filter(Boolean)
    .map((selector) => scopedSelector(selector, scope))
    .join(', ');
}

function scopedSelector(selector: string, scope: string): string {
  const [first, rest] = firstCompound(selector);
  if (isRoot(first)) {
    const root = `${scope}${qualifiers(first)}`;
    const [next, after] = firstCompound(rest.replace(/^\s*>?\s*/, ''));
    return isBody(next) ? `${root} > div${qualifiers(next)}${after}` : `${root}${rest}`;
  }
  if (isBody(first)) return `${scope} > div${qualifiers(first)}${rest}`;
  return `${scope} ${selector}`;
}

/** A selector's first compound, and the rest from the combinator after it. */
function firstCompound(selector: string): [string, string] {
  const parts = splitTopLevel(selector, ' \t\n\r\f>+~', true);
  const first = parts[0] ?? '';
  return [first, selector.slice(first.length)];
}

function isRoot(compound: string): boolean {
  return /^(?:html(?![\w-])|:root(?![\w-]))/i.test(compound);
}

function isBody(compound: string): boolean {
  return /^body(?![\w-])/i.test(compound);
}

/** What a compound says beyond its element's type or `:root`. */
function qualifiers(compound: string): string {
  return compound.replace(/^(?:html|body)(?![\w-])/i, '').replace(/:root(?![\w-])/gi, '');
}

/**
 * Text split at each of `separators` that is outside brackets, strings, comments and escapes.
 * With `firstOnly`, only the text before the first is returned.
 */
function splitTopLevel(text: string, separators: string, firstOnly = false): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let at = 0; at < text.length; at++) {
    const char = text[at]!;
    if (char === '\\') at++;
    else if (char === '"' || char === "'") at = stringEnd(text, at, text.length);
    else if (text.startsWith('/*', at)) at = commentEnd(text, at, text.length);
    else if (char === '(' || char === '[') depth++;
    else if (char === ')' || char === ']') depth = Math.max(0, depth - 1);
    else if (depth === 0 && separators.includes(char)) {
      parts.push(text.slice(start, at));
      if (firstOnly) return parts;
      start = at + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}
