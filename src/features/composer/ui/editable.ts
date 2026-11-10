import DOMPurify from 'dompurify';

/** What the editor holds of mail: text, its emphasis and structure, links, and inline images. */
const TAGS = [
  'p',
  'div',
  'br',
  'span',
  'b',
  'strong',
  'i',
  'em',
  's',
  'strike',
  'del',
  'code',
  'pre',
  'blockquote',
  'ul',
  'ol',
  'li',
  'a',
  'h1',
  'h2',
  'h3',
  'img',
];

/**
 * A draft another client wrote as HTML alone, made safe to open in the editor, which turns it into
 * Markdown: everything the editor can't hold is left out, keeping its words. A link keeps only a
 * web or mail address, and an image only one the draft carries by `cid:`, so opening a draft
 * loads nothing. Whatever is left out of its markup is rewritten in the sanitizer's own hooks.
 */
export function editableHtml(html: string): string {
  const purify = DOMPurify(window);
  purify.addHook('uponSanitizeAttribute', (_element, data) => {
    const value = data.attrValue.trim();
    if (data.attrName === 'href' && !/^(https?|mailto):/i.test(value)) data.keepAttr = false;
    if (data.attrName === 'src' && !/^cid:/i.test(value)) data.keepAttr = false;
  });
  purify.addHook('afterSanitizeAttributes', (element) => {
    if (element.localName === 'img' && !element.hasAttribute('src')) element.remove();
  });
  return purify.sanitize(html, { ALLOWED_TAGS: TAGS, ALLOWED_ATTR: ['href', 'src', 'alt'] });
}
