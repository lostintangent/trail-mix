import { schemeRule, SCHEME_ATTRIBUTE, type Adapted } from './colors.ts';

/**
 * A message's CSS, made safe to keep: its style sheets' rules, as the browser parsed them, kept
 * only when nothing in them loads what no rewrite can make safe, and every resource in the text
 * that remains rewritten.
 *
 * Every resource a piece of CSS can load is found the way a browser's tokenizer finds it (CSS
 * Syntax Level 3), so no escape, case or quoting can hide one.
 *
 * A resource is the target of a `url()`, or a string inside a function that takes images as
 * strings, such as `image-set("a.png" 1x)`. Each is replaced by what `resolve` returns, or by
 * `none` when it returns null. An image function with any unresolved image becomes `none` whole.
 *
 * An `@import` is dropped whole, since a message never loads a stylesheet.
 *
 * Where browsers disagree on which characters an identifier may hold, a name that merely ends in
 * `url` is read as `url`, so a character one browser splits off cannot hide a load.
 *
 * Strings and resources are written anew, with `<` escaped, so none can close the `<style>` element
 * it is written into. Everything else comes out exactly as written, never decoded, so a browser
 * reads it as this did.
 */

/** Where a resource named in CSS loads from instead, or null to load nothing. */
type Resolve = (url: string) => string | null;

export function rewriteCssResources(css: string, resolve: Resolve): string {
  return rewrite(css, 0, css.length, 'values', resolve).text;
}

/** Inside these, a string names an image. Inside any other function, a string is just a string. */
const IMAGE_FUNCTIONS = ['image-set', 'image', 'cross-fade', 'src'];

type Mode = 'values' | 'images';
type Rewritten = { text: string; unresolved: boolean };

function rewrite(css: string, from: number, to: number, mode: Mode, resolve: Resolve): Rewritten {
  let text = '';
  let unresolved = false;
  let i = from;
  while (i < to) {
    const c = css[i] ?? '';
    if (c === '/' && css[i + 1] === '*') {
      const close = css.indexOf('*/', i + 2);
      const end = close < 0 || close + 2 > to ? to : close + 2;
      text += css.slice(i, end);
      i = end;
    } else if (c === '"' || c === "'") {
      const string = consumeString(css, i, to);
      if (mode === 'images') {
        const url = string.bad ? null : resolve(string.value);
        if (url === null) unresolved = true;
        else text += serializeString(url);
      } else {
        text += serializeString(string.value);
      }
      i = string.next;
    } else if (c === '@' && startsIdent(css, i + 1, to)) {
      const keyword = consumeName(css, i + 1, to);
      if (asciiLowercase(keyword.name).endsWith('import')) {
        unresolved = true;
        i = endOfAtRule(css, keyword.next, to);
      } else {
        text += css.slice(i, keyword.next);
        i = keyword.next;
      }
    } else if (startsIdent(css, i, to)) {
      const ident = consumeName(css, i, to);
      if (ident.next >= to || css[ident.next] !== '(') {
        text += css.slice(i, ident.next);
        i = ident.next;
        continue;
      }
      const name = asciiLowercase(ident.name);
      if (name.endsWith('url')) {
        const url = consumeUrlFunction(css, ident.next + 1, to);
        const target = url.value === null ? null : resolve(url.value);
        if (target === null) unresolved = true;
        text += target === null ? 'none' : `url(${serializeString(target)})`;
        i = url.next;
        continue;
      }
      const images = IMAGE_FUNCTIONS.some((image) => name.endsWith(image));
      const close = findClose(css, ident.next + 1, to);
      const inner = rewrite(css, ident.next + 1, close, images ? 'images' : 'values', resolve);
      if (inner.unresolved) unresolved = true;
      // The name goes out as written: decoded, an escaped `(` in it would start a new function.
      const written = css.slice(i, ident.next);
      text += images && inner.unresolved ? 'none' : `${written}(${inner.text})`;
      i = Math.min(close + 1, to);
    } else {
      text += c;
      i++;
    }
  }
  return { text, unresolved };
}

/** A `url(` function's target, null for a malformed one, and where the function ends. */
function consumeUrlFunction(css: string, start: number, to: number) {
  let i = skipWhitespace(css, start, to);
  const c = css[i];
  if (c === '"' || c === "'") {
    // `url("…")` is a function whose argument is a string.
    const string = consumeString(css, i, to);
    const close = findClose(css, string.next, to);
    return { value: string.bad ? null : string.value, next: Math.min(close + 1, to) };
  }
  let value = '';
  while (i < to) {
    const char = css[i] ?? '';
    if (char === ')') return { value, next: i + 1 };
    if (isWhitespace(char)) {
      i = skipWhitespace(css, i, to);
      if (i >= to || css[i] === ')') return { value, next: Math.min(i + 1, to) };
      return { value: null, next: consumeBadUrl(css, i, to) };
    }
    if (char === '"' || char === "'" || char === '(' || isNonPrintable(char)) {
      return { value: null, next: consumeBadUrl(css, i, to) };
    }
    if (char === '\\') {
      if (!isValidEscape(css, i, to)) return { value: null, next: consumeBadUrl(css, i, to) };
      const escape = consumeEscape(css, i + 1, to);
      value += escape.char;
      i = escape.next;
      continue;
    }
    value += char;
    i++;
  }
  return { value, next: to };
}

function consumeBadUrl(css: string, start: number, to: number): number {
  let i = start;
  while (i < to) {
    if (css[i] === ')') return i + 1;
    i = isValidEscape(css, i, to) ? consumeEscape(css, i + 1, to).next : i + 1;
  }
  return to;
}

function consumeString(css: string, start: number, to: number) {
  const quote = css[start];
  let value = '';
  let i = start + 1;
  while (i < to) {
    const c = css[i] ?? '';
    if (c === quote) return { value, next: i + 1, bad: false };
    if (isNewline(c)) return { value, next: i, bad: true };
    if (c === '\\') {
      if (i + 1 >= to) {
        i++;
      } else if (isNewline(css[i + 1] ?? '')) {
        i += css[i + 1] === '\r' && css[i + 2] === '\n' ? 3 : 2;
      } else {
        const escape = consumeEscape(css, i + 1, to);
        value += escape.char;
        i = escape.next;
      }
      continue;
    }
    value += c;
    i++;
  }
  return { value, next: to, bad: false };
}

function consumeName(css: string, start: number, to: number) {
  let name = '';
  let i = start;
  while (i < to) {
    const c = css[i] ?? '';
    if (isNameChar(c)) {
      name += c;
      i++;
    } else if (isValidEscape(css, i, to)) {
      const escape = consumeEscape(css, i + 1, to);
      name += escape.char;
      i = escape.next;
    } else {
      break;
    }
  }
  return { name, next: i };
}

/** The code point an escape stands for, read from just after its backslash. */
function consumeEscape(css: string, start: number, to: number) {
  if (start >= to) return { char: '\uFFFD', next: to };
  let hex = '';
  let i = start;
  while (i < to && hex.length < 6 && /[0-9a-fA-F]/.test(css[i] ?? '')) hex += css[i++];
  if (hex) {
    if (isWhitespace(css[i] ?? '')) i += css[i] === '\r' && css[i + 1] === '\n' ? 2 : 1;
    const code = parseInt(hex, 16);
    const valid = code !== 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff);
    return { char: valid ? String.fromCodePoint(code) : '\uFFFD', next: i };
  }
  const char = String.fromCodePoint(css.codePointAt(start) ?? 0xfffd);
  return { char, next: start + char.length };
}

/** The index of the `)` that closes a function whose arguments start at `start`, or `to`. */
function findClose(css: string, start: number, to: number): number {
  return scanTo(css, start, to, ')');
}

/** Where an at-rule that starts its prelude at `start` ends: after its `;` or its block. */
function endOfAtRule(css: string, start: number, to: number): number {
  const end = scanTo(css, start, to, ';');
  if (css[end] !== '{') return Math.min(end + 1, to);
  return Math.min(scanTo(css, end + 1, to, '}') + 1, to);
}

/** The index of `stop` outside any string, comment, url or nesting, or `to`. */
function scanTo(css: string, start: number, to: number, stop: ')' | ';' | '}'): number {
  let depth = 0;
  let i = start;
  while (i < to) {
    const c = css[i] ?? '';
    if (c === '/' && css[i + 1] === '*') {
      const close = css.indexOf('*/', i + 2);
      i = close < 0 ? to : close + 2;
    } else if (c === '"' || c === "'") {
      i = consumeString(css, i, to).next;
    } else if (c === '\\') {
      i = isValidEscape(css, i, to) ? consumeEscape(css, i + 1, to).next : i + 1;
    } else if (startsIdent(css, i, to)) {
      const ident = consumeName(css, i, to);
      // An unquoted url may hold characters that would otherwise look like nesting.
      const isUrl = css[ident.next] === '(' && asciiLowercase(ident.name).endsWith('url');
      i = isUrl ? consumeUrlFunction(css, ident.next + 1, to).next : ident.next;
    } else if (depth === 0 && (c === stop || (stop === ';' && c === '{'))) {
      return i;
    } else if (c === '(' || c === '[' || c === '{') {
      depth++;
      i++;
    } else {
      if (c === ')' || c === ']' || c === '}') depth = Math.max(0, depth - 1);
      i++;
    }
  }
  return to;
}

function startsIdent(css: string, i: number, to: number): boolean {
  const c = css[i] ?? '';
  if (c === '-') {
    const next = css[i + 1] ?? '';
    return i + 1 < to && (isNameStart(next) || next === '-' || isValidEscape(css, i + 1, to));
  }
  return isNameStart(c) || isValidEscape(css, i, to);
}

function isValidEscape(css: string, i: number, to: number): boolean {
  return css[i] === '\\' && i + 1 < to && !isNewline(css[i + 1] ?? '');
}

function serializeString(value: string): string {
  let out = '"';
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (char === '"' || char === '\\') out += `\\${char}`;
    else if (code < 0x20 || code === 0x7f || char === '<') out += `\\${code.toString(16)} `;
    else out += char;
  }
  return `${out}"`;
}

function skipWhitespace(css: string, start: number, to: number): number {
  let i = start;
  while (i < to && isWhitespace(css[i] ?? '')) i++;
  return i;
}

function asciiLowercase(value: string): string {
  return value.replace(/[A-Z]/g, (c) => c.toLowerCase());
}

const isNewline = (c: string) => c === '\n' || c === '\r' || c === '\f';
const isWhitespace = (c: string) => c === ' ' || c === '\t' || isNewline(c);
const isNameStart = (c: string) => /[a-zA-Z_]/.test(c) || (c.codePointAt(0) ?? 0) >= 0x80;
const isNameChar = (c: string) => isNameStart(c) || /[0-9-]/.test(c);
const isNonPrintable = (c: string) => {
  const code = c.codePointAt(0) ?? 0;
  return code <= 0x08 || code === 0x0b || (code >= 0x0e && code <= 0x1f) || code === 0x7f;
};

/**
 * Drops the rules that load something no image rewrite can make safe: fonts, and counter styles
 * and registered properties, whose images CSS reaches without `url()` in a value. Every rule kept
 * has its colors adapted, and a rule for one color scheme is rewritten to follow the frame's.
 */
export function keepSafeRules(
  rules: CSSRuleList,
  adapt: (style: CSSStyleDeclaration) => Adapted,
  lightInk: string,
) {
  for (let i = rules.length - 1; i >= 0; i--) {
    const rule = rules[i];
    if (!rule) continue;
    const name = rule.constructor.name;
    if (
      name === 'CSSFontFaceRule' ||
      name === 'CSSCounterStyleRule' ||
      name === 'CSSPropertyRule'
    ) {
      deleteRule(rule, i);
      continue;
    }
    if ('style' in rule && rule.style instanceof CSSStyleDeclaration) {
      const { needsInk } = adapt(rule.style);
      // Text in what the rule paints takes the light theme's ink in the dark theme, short of any
      // color the message sets on it, which `:where` lets win.
      if (needsInk && 'selectorText' in rule && typeof rule.selectorText === 'string') {
        insertAfter(
          rule,
          i,
          `@scope (:root[${SCHEME_ATTRIBUTE}="dark"]) { :where(${rule.selectorText}) { color: ${lightInk}; } }`,
        );
      }
    }
    if ('cssRules' in rule && rule.cssRules instanceof CSSRuleList) {
      keepSafeRules(rule.cssRules, adapt, lightInk);
    }
    const themed = name === 'CSSMediaRule' ? schemeRule(rule as CSSMediaRule) : undefined;
    if (themed) replaceRule(rule, i, themed);
  }
}

/** Puts `text` just after a rule, or nothing where a browser can't read it. */
function insertAfter(rule: CSSRule, index: number, text: string) {
  const parent = rule.parentRule ?? rule.parentStyleSheet;
  if (!parent || !('insertRule' in parent)) return;
  try {
    parent.insertRule(text, index + 1);
  } catch {
    // A browser that reads no `@scope` leaves the text in the dark theme's ink.
  }
}

function deleteRule(rule: CSSRule, index: number) {
  const parent = rule.parentRule ?? rule.parentStyleSheet;
  if (parent && 'deleteRule' in parent) parent.deleteRule(index);
}

/** Puts `text` in the place of a rule, or leaves the rule as it is where a browser can't read it. */
function replaceRule(rule: CSSRule, index: number, text: string) {
  const parent = rule.parentRule ?? rule.parentStyleSheet;
  if (!parent || !('insertRule' in parent)) return;
  try {
    parent.insertRule(text, index);
  } catch {
    return;
  }
  parent.deleteRule(index + 1);
}
