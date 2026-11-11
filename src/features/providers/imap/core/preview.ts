/**
 * A message's preview: the first words a person would read in it, for the list's third line, from
 * the start of its plain text part and of its HTML part. The plain text is read first, and the HTML
 * when there is no plain text or it has no words to read, as a newsletter's often hasn't.
 */
export function previewFrom({ plain, html }: { plain?: string; html?: string }): string {
  return (plain === undefined ? '' : previewOf(plain, false)) || previewOf(html ?? '', true);
}

/**
 * The preview one part gives. It leaves out what nobody reads as words: quoted lines, invisible
 * padding, and rules drawn with marks such as `*`, `=`, `-` or `_`. A sender's plain text is often
 * its HTML turned into Markdown, with table bars, heading marks, links' and images' addresses
 * written out, and entities its HTML wrote, and mail written in Trail Mix is Markdown too, so plain
 * text is read as its message shows it, by the words alone.
 */
export function previewOf(text: string, html: boolean): string {
  return (html ? textOfHtml(text) : decoded(text))
    .split(/\r\n|\r|\n/)
    .filter((line) => !line.trimStart().startsWith('>') && !DRAWN.test(line))
    .map((line) => {
      const shown = line.replace(INVISIBLE, ' ').replace(SOFT_HYPHEN, '').replace(RULE, ' ');
      return html ? shown : wordsOfMarkdown(shown);
    })
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, PREVIEW_LENGTH);
}

const PREVIEW_LENGTH = 200;

/** A line drawn only with marks, such as a rule, a table's bars, or a separator row. */
const DRAWN = /^[\s*=_~#|+:.`'"^•·–—-]+$/;
/** A rule inside a line: a mark three times or more. */
const RULE = /([*=_~#–—-])\1{2,}/g;
/** Characters that take no space, which newsletters pad with. A joiner stays, as emoji need it. */
const INVISIBLE = /(?:\u200b|\u200c|\u034f|\u180e|\u2060|\ufeff)+/g;
const SOFT_HYPHEN = /\u00ad/g;

/** A line of Markdown as its words, with each image's alt text and each link's text kept. */
function wordsOfMarkdown(line: string): string {
  // A mark written with a backslash is the character itself, so it is set aside until the end.
  const aside = line.replace(/\\([!-/:-@[-`{-~])/g, (_, mark: string) => hidden(mark));
  // A table's cells each keep a space where they ended, so none runs into the next.
  return aside
    .split('|')
    .map(wordsOfCell)
    .join(' ')
    .replace(/[\ue021-\ue07e]/g, shown);
}

function wordsOfCell(cell: string): string {
  const unheaded = HEADING.test(cell)
    ? cell.replace(HEADING, '').replace(/[ \t]+#+[ \t]*$/, '')
    : cell.replace(BULLET, '');
  return (
    unheaded
      // A link cut off where the fetched text ends still reads as its words.
      .replace(/!\[([^\]]*)\]\([^)]*\)?/g, ' $1 ')
      .replace(/\[image:\s*([^\]]*)\]/gi, ' $1 ')
      .replace(/\[([^\]]+)\]\([^)]*\)?/g, '$1')
      // A link's address written after its words, in parentheses or angle brackets.
      .replace(/[(<]\s*(?:https?|mailto):[^\s)>]*\s*[)>]?/gi, ' ')
      .replace(/(`+)(.+?)\1/g, '$2')
      .replace(/\*\*(?=\S)(.+?)(?<=\S)\*\*/g, '$1')
      .replace(/(^|\W)__(?=\S)(.+?)(?<=\S)__(?!\w)/g, '$1$2')
      .replace(/~~(?=\S)(.+?)(?<=\S)~~/g, '$1')
      // A single mark emphasizes only from outside a word, so snake_case and 2 * 3 stay as they are.
      .replace(/(^|[^\w*])\*(?=[^\s*])(.+?)(?<=[^\s*])\*(?![\w*])/g, '$1$2')
      .replace(/(^|[^\w_])_(?=[^\s_])(.+?)(?<=[^\s_])_(?![\w_])/g, '$1$2')
  );
}

/** A heading's marks, with or without the space Markdown wants after them, but `#tag` is a word. */
const HEADING = /^\s*(?:#{1,6}[ \t]+|#{2,6}(?=[^\s#]))/;
const BULLET = /^\s*[*+•-][ \t]+/;

const hidden = (mark: string) => String.fromCharCode(0xe000 + mark.charCodeAt(0));
const shown = (mark: string) => String.fromCharCode(mark.charCodeAt(0) - 0xe000);

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ensp: ' ',
  emsp: ' ',
  thinsp: ' ',
  zwnj: '\u200c',
  zwj: '\u200d',
  shy: '\u00ad',
  lsquo: '‘',
  rsquo: '’',
  sbquo: '‚',
  ldquo: '“',
  rdquo: '”',
  bdquo: '„',
  laquo: '«',
  raquo: '»',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  bull: '•',
  middot: '·',
  copy: '©',
  reg: '®',
  trade: '™',
  deg: '°',
  times: '×',
  euro: '€',
  pound: '£',
  yen: '¥',
  cent: '¢',
};

/** Text a person would read in HTML, closely enough for a preview. Nothing here is rendered. */
function textOfHtml(html: string): string {
  return decoded(
    html
      .replace(/<(head|style|script|title)\b[\s\S]*?(<\/\1\s*>|$)/gi, ' ')
      .replace(/<blockquote\b[\s\S]*?(<\/blockquote\s*>|$)/gi, ' ')
      .replace(/<(br|p|div|tr|li|h\d)\b[^>]*>/gi, '\n')
      .replace(/<[^>]*>?/g, ' '),
  );
}

/** Text with HTML's character references written as the characters they stand for. */
function decoded(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity: string, name: string) => {
    if (name.startsWith('#')) {
      const code =
        name[1]?.toLowerCase() === 'x' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000
        ? String.fromCodePoint(code)
        : ' ';
    }
    return ENTITIES[name.toLowerCase()] ?? entity;
  });
}
