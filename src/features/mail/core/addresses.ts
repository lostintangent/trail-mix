import type { Address } from './model.ts';

/** The domain of an address, after its last `@`, in lowercase, or empty when it has none. */
export function domainOf(address: string): string {
  const at = address.lastIndexOf('@');
  return at < 0
    ? ''
    : address
        .slice(at + 1)
        .trim()
        .toLowerCase();
}

/**
 * The addresses in an address-list header, such as From, To or Reply-To, as a message carries it:
 * unfolded, but with its encoded words still encoded. Each mailbox gives one address, with its
 * display name decoded, and a group gives its members. A mailbox with no `@` gives nothing.
 *
 * It reads what mailers write as well as what RFC 5322 allows: commas inside quotes and comments,
 * a name that is only a comment after a bare address, encoded words inside quotes, and an angle
 * address that is never closed.
 */
export function addressesIn(header: string): Address[] {
  const found: Address[] = [];
  let mailbox: Token[] = [];
  for (const token of tokensOf(header)) {
    // A comma or semicolon ends a mailbox. A colon ends a group's name, which has no address, and
    // the group's members are mailboxes like any other.
    if (token.kind === 'special') {
      const address = addressOf(mailbox);
      if (address) found.push(address);
      mailbox = [];
    } else {
      mailbox.push(token);
    }
  }
  const last = addressOf(mailbox);
  if (last) found.push(last);
  return found;
}

type Token = { kind: 'atom' | 'quoted' | 'comment' | 'angle' | 'special'; text: string };

function tokensOf(header: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  /** The text up to `close`, with backslash escapes undone, and nested pairs when `open` is set. */
  const until = (close: string, open?: string) => {
    let text = '';
    let depth = 0;
    for (i++; i < header.length; i++) {
      const char = header[i]!;
      if (char === '\\' && i + 1 < header.length) {
        text += header[++i];
        continue;
      }
      if (char === close && depth === 0) break;
      if (char === open) depth++;
      if (char === close) depth--;
      text += char;
    }
    i++;
    return text;
  };
  while (i < header.length) {
    const char = header[i]!;
    if (/\s/.test(char)) i++;
    else if (char === '"') tokens.push({ kind: 'quoted', text: until('"') });
    else if (char === '(') tokens.push({ kind: 'comment', text: until(')', '(') });
    else if (char === '<') tokens.push({ kind: 'angle', text: until('>') });
    else if (char === ',' || char === ';' || char === ':') {
      tokens.push({ kind: 'special', text: char });
      i++;
    } else {
      const start = i++;
      while (i < header.length && !/[\s"(<,;:]/.test(header[i]!)) i++;
      tokens.push({ kind: 'atom', text: header.slice(start, i) });
    }
  }
  return tokens;
}

/** One mailbox: a name and an angle address, or a bare address with perhaps a comment for a name. */
function addressOf(tokens: Token[]): Address | undefined {
  const angle = tokens.find((token) => token.kind === 'angle');
  const words = tokens.filter((token) => token.kind === 'atom' || token.kind === 'quoted');
  let email: string;
  let named: Token[];
  if (angle) {
    // A source route, `<@relay:ada@example.com>`, is obsolete, and only the address after it counts.
    email = angle.text.replace(/\s+/g, '').replace(/^@[^:]*:/, '');
    named = words;
  } else {
    const bare = words.findLast((token) => token.kind === 'atom' && token.text.includes('@'));
    email = bare?.text ?? '';
    named = words.filter((token) => token !== bare);
    if (named.length === 0) named = tokens.filter((token) => token.kind === 'comment');
  }
  if (!/^[^@\s]+@[^@\s]+$/.test(email)) return undefined;
  const name = nameOf(named);
  return name ? { name, email } : { email };
}

/** A display name's words joined by spaces, except between two encoded words, which join whole. */
function nameOf(words: Token[]): string {
  let name = '';
  let encoded = false;
  for (const word of words) {
    const whole = word.kind === 'atom' && ENCODED_WORD.test(word.text);
    if (name && !(whole && encoded)) name += ' ';
    name += decodeWords(word.text);
    encoded = whole;
  }
  return name.replace(/\s+/g, ' ').trim();
}

const ENCODED_WORD = /^(?:=\?[^?\s]+\?[bq]\?[^?\s]*\?=)+$/i;

/** Decodes every RFC 2047 encoded word in some text. One whose charset is unknown stays as it is. */
function decodeWords(text: string): string {
  return text.replace(
    /=\?([^?\s*]+)(?:\*[^?\s]*)?\?([bq])\?([^?\s]*)\?=/gi,
    (word, charset: string, encoding: string, data: string) => {
      try {
        const bytes =
          encoding.toLowerCase() === 'b'
            ? Uint8Array.from(atob(data), (char) => char.charCodeAt(0))
            : qBytes(data);
        return new TextDecoder(charset, { fatal: true, ignoreBOM: false }).decode(bytes);
      } catch {
        return word;
      }
    },
  );
}

function qBytes(data: string): Uint8Array {
  const bytes: number[] = [];
  for (let i = 0; i < data.length; i++) {
    const char = data[i]!;
    const hex = data.slice(i + 1, i + 3);
    if (char === '=' && /^[0-9a-f]{2}$/i.test(hex)) {
      bytes.push(parseInt(hex, 16));
      i += 2;
    } else {
      bytes.push(char === '_' ? 0x20 : char.charCodeAt(0));
    }
  }
  return new Uint8Array(bytes);
}
