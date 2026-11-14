import { Marked, type RendererObject, type Tokens } from 'marked';

/**
 * Markdown as mail. The composer's Markdown becomes the HTML part of what is sent and stays, as
 * written, the plain-text part, so the two must agree on what it means. marked is the tokenizer
 * Tiptap's Markdown extension uses, with GitHub's dialect, and a line break is a break, as it is
 * in the plain-text part.
 *
 * Mail clients drop style sheets, so every element carries its own inline style. These are the
 * message's styles, not Trail Mix's, so they are written here rather than taken from its theme.
 * None sets a color or a background, so a reader's dark mode still applies, and the gray of a rule
 * reads on either.
 * Raw HTML shows as the text it is, the way the editor showed it. A link keeps its address only if
 * a recipient could follow it, to the web, to mail or to a phone, and is otherwise its text.
 *
 * An image never goes out broken. It is on the web, or it travels with the message and is named by
 * `cid:` and its Content-ID. Any other image fails the render with an error that names it.
 */

/**
 * Renders Markdown as an HTML fragment. `contentIds` are the images that travel with the message,
 * and an image by `cid:` that is not among them fails the render.
 */
export function renderMarkdown(
  markdown: string,
  contentIds: ReadonlySet<string> = new Set(),
): string {
  const marked = new Marked(DIALECT, {
    renderer: renderer(contentIds),
    hooks: {
      postprocess: (html) =>
        html.replace(STYLED, (tag, name: keyof typeof STYLE) => `${tag} style="${STYLE[name]}"`),
    },
  });
  return `<div style="${STYLE.body}">${marked.parse(markdown) as string}</div>`;
}

/** The Content-IDs of the images the Markdown shows by `cid:`, in order, each once. */
export function contentIdsIn(markdown: string): string[] {
  const marked = new Marked(DIALECT);
  const ids = new Set<string>();
  // The walk returns what the callback does, which here is nothing.
  void marked.walkTokens(marked.lexer(markdown), (token) => {
    const id = token.type === 'image' ? cidOf((token as Tokens.Image).href) : undefined;
    if (id !== undefined) ids.add(id);
  });
  return [...ids];
}

const DIALECT = { gfm: true, breaks: true, async: false } as const;

const MONO = "ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace";
const GRAY = '#d0d7de';
const RULE = `1px solid ${GRAY}`;
const HEADING = 'margin: 0 0 0.5em; font-weight: 600; line-height: 1.25';

const H4 = `${HEADING}; font-size: 1em`;

const STYLE = {
  body: "font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif; line-height: 1.5",
  p: 'margin: 0 0 1em',
  h1: `${HEADING}; font-size: 1.5em`,
  h2: `${HEADING}; font-size: 1.3em`,
  h3: `${HEADING}; font-size: 1.15em`,
  h4: H4,
  h5: H4,
  h6: H4,
  blockquote: `margin: 0 0 1em; padding: 0 0 0 1em; border-left: 3px solid ${GRAY}`,
  pre: `margin: 0 0 1em; padding: 8px 12px; border: ${RULE}; border-radius: 6px; font-family: ${MONO}; font-size: 0.9em; line-height: 1.45; white-space: pre-wrap`,
  block: `font-family: ${MONO}`,
  code: `padding: 0.1em 0.3em; border: ${RULE}; border-radius: 4px; font-family: ${MONO}; font-size: 0.9em`,
  ul: 'margin: 0 0 1em; padding: 0 0 0 1.5em',
  ol: 'margin: 0 0 1em; padding: 0 0 0 1.5em',
  li: 'margin: 0.25em 0',
  table: 'margin: 0 0 1em; border-collapse: collapse',
  cell: `padding: 4px 8px; border: ${RULE}`,
  hr: `margin: 1.5em 0; border: 0; border-top: ${RULE}`,
  img: 'max-width: 100%; height: auto',
};

/** The tags marked writes itself, each given its style as it comes. */
const STYLED = /<(p|h[1-6]|blockquote|ul|ol|li|table|hr)(?=[ >])/g;

const LINKS = /^(?:https?:|mailto:|tel:)/i;
const REMOTE = /^https?:\/\//i;

function renderer(contentIds: ReadonlySet<string>): RendererObject<string, string> {
  return {
    code({ text }) {
      return `<pre style="${STYLE.pre}"><code style="${STYLE.block}">${escapeHtml(text)}</code></pre>\n`;
    },
    codespan({ text }) {
      return `<code style="${STYLE.code}">${escapeHtml(text)}</code>`;
    },
    // Mail clients strip form controls, so a task's box is a character.
    checkbox({ checked }) {
      return checked ? '☑ ' : '☐ ';
    },
    tablecell(cell) {
      const tag = cell.header ? 'th' : 'td';
      const weight = cell.header ? '; font-weight: 600' : '';
      const style = `${STYLE.cell}; text-align: ${cell.align ?? 'left'}${weight}`;
      return `<${tag} style="${style}">${this.parser.parseInline(cell.tokens)}</${tag}>`;
    },
    html(token) {
      const text = escapeHtml(token.text);
      return token.block ? `<p>${text.trimEnd().replace(/\n/g, '<br>')}</p>\n` : text;
    },
    link({ href, title, tokens }) {
      const text = this.parser.parseInline(tokens);
      if (!LINKS.test(href)) return text;
      return `<a href="${escapeHtml(href)}"${titleOf(title)}>${text}</a>`;
    },
    image({ href, title, text }) {
      const id = cidOf(href);
      if (id === undefined ? !REMOTE.test(href) : !contentIds.has(id)) {
        throw new Error(
          id === undefined
            ? `The image "${text}" is at ${href}, which is neither an attachment nor on the web.`
            : `The image "${text}" is the attachment ${id}, which the message doesn't carry.`,
        );
      }
      return `<img src="${escapeHtml(href)}" alt="${escapeHtml(text)}"${titleOf(title)} style="${STYLE.img}">`;
    },
  };
}

/** The Content-ID a `cid:` URL names. RFC 2392 writes it percent-encoded and without brackets. */
function cidOf(href: string): string | undefined {
  if (!/^cid:/i.test(href)) return undefined;
  try {
    return decodeURIComponent(href.slice(4));
  } catch {
    return href.slice(4);
  }
}

function titleOf(title: string | null | undefined): string {
  return title ? ` title="${escapeHtml(title)}"` : '';
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}
