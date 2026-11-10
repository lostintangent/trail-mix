import type { Address } from './model.ts';

/**
 * The one MIME writer. The demo mailbox, drafts and sending all turn a message into the bytes a
 * mail server stores, and they all do it here.
 *
 * It is pure: the date, the Message-ID and the boundary are inputs, so the same message always
 * gives the same bytes. What it writes is 7-bit, with CRLF line endings and no line over 998
 * octets, so any server accepts it unchanged: non-ASCII headers become RFC 2047 encoded words or
 * RFC 2231 parameters, and bodies are quoted-printable or base64 unless plain ASCII says it all.
 */

export type MimeMessage = {
  /** ISO 8601. Mail dates go to the second. */
  date: string;
  /** In `<id@host>` form. */
  messageId: string;
  from: Address;
  to: Address[];
  cc?: Address[];
  /** Kept on a draft, and left off by whatever submits it. */
  bcc?: Address[];
  subject: string;
  /** The thread's first message first. The last is the parent, also written as In-Reply-To. */
  references?: string[];
  /** Anything else, such as List-Id, written as given after the standard headers. ASCII only. */
  headers?: [name: string, value: string][];
  text?: string;
  html?: string;
  attachments?: MimeAttachment[];
  /**
   * Makes every part boundary, so it is unique to this message. Letters, digits and `'()+_,-./:?`
   * only. Each boundary starts with `=_`, which no quoted-printable or base64 line can contain.
   */
  boundary: string;
};

/**
 * A file. An image with a Content-ID is one the HTML shows by `cid:`, so it goes inline with the
 * HTML. Anything else is attached, since readers take inline text for part of the body.
 */
export type MimeAttachment = {
  name: string;
  type: string;
  content: Uint8Array;
  contentId?: string;
};

/**
 * The message as a string of 7-bit characters, which is also its bytes. The text and HTML are
 * alternatives, inline images are related to the HTML, and other attachments are mixed in after.
 */
export function writeMime(message: MimeMessage): string {
  if (!/^[\w'()+,\-./:?]{1,60}$/.test(message.boundary)) {
    throw new Error(`"${message.boundary}" cannot make MIME boundaries.`);
  }
  const attachments = message.attachments ?? [];
  const inline = message.html
    ? attachments.filter((file) => file.contentId && file.type.startsWith('image/'))
    : [];
  const attached = attachments.filter((file) => !inline.includes(file));

  const html = message.html === undefined ? undefined : textPart('html', message.html);
  const shown = inline.length
    ? multipart('related', [html!, ...inline.map((file) => filePart(file, true))])
    : html;
  const text = message.text === undefined ? undefined : textPart('plain', message.text);
  const body =
    text && shown
      ? multipart('alternative', [text, shown])
      : (text ?? shown ?? textPart('plain', ''));
  const root = attached.length
    ? multipart('mixed', [body, ...attached.map((file) => filePart(file, false))])
    : body;

  const references = message.references ?? [];
  const headers: Header[] = [
    ['Date', rfc5322Date(message.date)],
    ['From', addresses([message.from])],
    ['To', addresses(message.to)],
    ['Cc', addresses(message.cc ?? [])],
    ['Bcc', addresses(message.bcc ?? [])],
    ['Subject', unstructured(message.subject)],
    ['Message-ID', messageIds([message.messageId])],
    ['In-Reply-To', messageIds(references.slice(-1))],
    ['References', messageIds(references)],
    ...(message.headers ?? []).map(([name, value]): Header => [headerName(name), verbatim(value)]),
    ['MIME-Version', '1.0'],
  ];
  let boundaries = 0;
  const raw = render(root, headers, () => `=_${message.boundary}_${boundaries++}`);
  return 'parts' in root ? `${raw}\r\n` : raw;
}

// Parts

type Part = { headers: Header[]; body: string } | { subtype: string; parts: Part[] };

function textPart(subtype: 'plain' | 'html', text: string): Part {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  // Plain only when no transport could change it: short lines, no `=`, nothing trailing a line.
  const plain = lines.every(
    (line) => line.length <= 76 && /^([\x20-\x3c\x3e-\x7e\t]*[\x21-\x3c\x3e-\x7e])?$/.test(line),
  );
  return {
    headers: [
      ['Content-Type', `text/${subtype}; charset=utf-8`],
      ['Content-Transfer-Encoding', plain ? '7bit' : 'quoted-printable'],
    ],
    body: plain ? lines.join('\r\n') : lines.map(quotedPrintable).join('\r\n'),
  };
}

function filePart(file: MimeAttachment, inline: boolean): Part {
  const type = /^[\w.+-]+\/[\w.+-]+$/.test(file.type) ? file.type : 'application/octet-stream';
  const disposition = inline ? 'inline' : 'attachment';
  return {
    headers: [
      ['Content-Type', [`${type};`, ...parameter('name', file.name)]],
      ['Content-Transfer-Encoding', 'base64'],
      ['Content-Disposition', [`${disposition};`, ...parameter('filename', file.name)]],
      ['Content-ID', inline ? messageIds([`<${file.contentId}>`]) : []],
    ],
    body: base64(file.content),
  };
}

function multipart(subtype: string, parts: Part[]): Part {
  return { subtype, parts };
}

function render(part: Part, headers: Header[], boundary: () => string): string {
  if ('body' in part) return `${headerLines([...headers, ...part.headers])}\r\n${part.body}`;
  const delimiter = boundary();
  const contentType: Header = [
    'Content-Type',
    `multipart/${part.subtype}; boundary="${delimiter}"`,
  ];
  const parts = part.parts.map((inner) => `--${delimiter}\r\n${render(inner, [], boundary)}\r\n`);
  return `${headerLines([...headers, contentType])}\r\n${parts.join('')}--${delimiter}--`;
}

// Bodies

/** One line of text as quoted-printable, with soft breaks so no encoded line passes 76 characters. */
function quotedPrintable(line: string): string {
  const bytes = new TextEncoder().encode(line);
  const lines: string[] = [];
  let current = '';
  bytes.forEach((byte, i) => {
    const last = i === bytes.length - 1;
    const literal =
      (byte >= 33 && byte <= 126 && byte !== 61) || ((byte === 32 || byte === 9) && !last);
    const token = literal
      ? String.fromCharCode(byte)
      : `=${byte.toString(16).toUpperCase().padStart(2, '0')}`;
    if (current.length + token.length > 75) {
      lines.push(`${current}=`);
      current = '';
    }
    current += token;
  });
  return [...lines, current].join('\r\n');
}

function base64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return (btoa(binary).match(/.{1,76}/g) ?? ['']).join('\r\n');
}

// Headers. Each value is written as tokens that must stay whole, separated by spaces where a line
// may fold, so folding never changes what the header says.

type Tokens = string[];

/** A header with no tokens is left out. */
type Header = [name: string, value: string | Tokens];

/** Folds each header at its spaces, so lines stay within 78 characters wherever a token allows. */
function headerLines(headers: Header[]): string {
  return headers
    .filter(([, value]) => value.length > 0)
    .map(([name, value]) => {
      const tokens = typeof value === 'string' ? [value] : value;
      const lines: string[] = [];
      let line = `${name}:`;
      for (const token of tokens) {
        if (line.length + 1 + token.length > 78 && line.length > name.length + 1) {
          lines.push(line);
          line = '';
        }
        line += ` ${token}`;
      }
      return `${[...lines, line].join('\r\n')}\r\n`;
    })
    .join('');
}

/** Free text, such as a subject, as plain words when it is plain ASCII, or else encoded words. */
function unstructured(text: string): Tokens {
  return isPlain(text, 70) ? text.split(' ') : encodedWords(text);
}

/** A structured value, such as List-Unsubscribe, folded at its spaces but otherwise as given. */
function verbatim(value: string): Tokens {
  const tokens = value.split(' ');
  if (!/^[\x21-\x7e]+( [\x21-\x7e]+)*$/.test(value) || tokens.some((token) => token.length > 900)) {
    throw new Error(`"${value}" is not a header value that can be written as given.`);
  }
  return tokens;
}

/** An address of printable ASCII, with none of the characters that would end it early. */
const ADDRESS = /^[!#-'*+\-./0-9=?A-Z^-~]+@[!#-'*+\-./0-9=?A-Z^-~]+$/;

function addresses(list: readonly Address[]): Tokens {
  return list.flatMap(({ name, email }, i) => {
    if (!ADDRESS.test(email)) {
      throw new Error(`"${email}" is not an address a MIME header can carry.`);
    }
    const comma = i < list.length - 1 ? ',' : '';
    if (!name) return [`${email}${comma}`];
    return [...displayName(name), `<${email}>${comma}`];
  });
}

/** A name as atoms when it can be, a quoted string when it is ASCII, or else encoded words. */
function displayName(name: string): Tokens {
  if (isPlain(name, 60) && /^[\w!#$%&'*+\-/=?^`{|}~ ]+$/.test(name)) return name.split(' ');
  if (isPlain(name, 60)) return [`"${name.replace(/[\\"]/g, '\\$&')}"`];
  return encodedWords(name);
}

/** Printable ASCII, single spaces between words, no word longer than `longest`, nothing encoded. */
function isPlain(text: string, longest: number): boolean {
  return (
    /^[\x21-\x7e]+( [\x21-\x7e]+)*$/.test(text) &&
    !text.includes('=?') &&
    text.split(' ').every((word) => word.length <= longest)
  );
}

/** RFC 2047 encoded words of at most 75 characters, split between characters, never inside one. */
function encodedWords(text: string): Tokens {
  const encoder = new TextEncoder();
  const words: Tokens = [];
  let chunk = '';
  for (const char of text) {
    if (encoder.encode(chunk + char).length > 45) {
      words.push(chunk);
      chunk = '';
    }
    chunk += char;
  }
  if (chunk || words.length === 0) words.push(chunk);
  return words.map((word) => `=?UTF-8?B?${base64(encoder.encode(word))}?=`);
}

function messageIds(ids: readonly string[]): Tokens {
  for (const id of ids) {
    if (!/^<[\x21-\x3b\x3d\x3f-\x7e]{1,900}>$/.test(id)) {
      throw new Error(`"${id}" is not a Message-ID a MIME header can carry.`);
    }
  }
  return [...ids];
}

/** A parameter as a quoted string when it is short ASCII, or else RFC 2231 percent-encoded pieces. */
function parameter(name: string, value: string): Tokens {
  if (/^[\x20-\x7e]{0,60}$/.test(value)) return [`${name}="${value.replace(/[\\"]/g, '\\$&')}"`];
  const encoded = [...new TextEncoder().encode(value)]
    .map((byte) =>
      /[\w!#$&+\-.^`|~]/.test(String.fromCharCode(byte))
        ? String.fromCharCode(byte)
        : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`,
    )
    .join('');
  const pieces = encoded.match(/(%[0-9A-F]{2}|[^%]){1,20}/g) ?? [];
  return pieces.map(
    (piece, i) =>
      `${name}*${i}*=${i === 0 ? "utf-8''" : ''}${piece}${i < pieces.length - 1 ? ';' : ''}`,
  );
}

function headerName(name: string): string {
  if (!/^[\x21-\x39\x3b-\x7e]+$/.test(name)) throw new Error(`"${name}" is not a header name.`);
  return name;
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** An ISO 8601 date as RFC 5322 writes it, in UTC. */
function rfc5322Date(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) throw new Error(`"${iso}" is not a date.`);
  const two = (n: number) => String(n).padStart(2, '0');
  return `${DAYS[date.getUTCDay()]}, ${two(date.getUTCDate())} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()} ${two(date.getUTCHours())}:${two(date.getUTCMinutes())}:${two(date.getUTCSeconds())} +0000`;
}
