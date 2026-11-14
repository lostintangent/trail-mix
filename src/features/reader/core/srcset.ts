/**
 * A `srcset`, read as the HTML standard reads it, so no candidate a browser would load can pass
 * unseen, and written back with each candidate's URL rewritten.
 */

/** Rewrites each candidate of a `srcset`, keeping only those that resolve. */
export function rewriteSrcset(
  value: string,
  resolve: (url: string) => string | null,
): string | null {
  const candidates: string[] = [];
  for (const { url, descriptor } of parseSrcset(value)) {
    const source = resolve(url);
    if (source) candidates.push(descriptor ? `${source} ${descriptor}` : source);
  }
  return candidates.length ? candidates.join(', ') : null;
}

/**
 * The candidates of a `srcset`, split as the HTML standard splits them. A candidate a browser would
 * drop is dropped, and the one descriptor kept must match the standard's grammar whole, so no text
 * after a URL can carry another candidate.
 */
export function parseSrcset(value: string): { url: string; descriptor: string }[] {
  const candidates: { url: string; descriptor: string }[] = [];
  let i = 0;
  while (i < value.length) {
    while (i < value.length && /[\t\n\f\r ,]/.test(value[i] ?? '')) i++;
    if (i >= value.length) break;
    const start = i;
    while (i < value.length && !isHtmlSpace(value[i] ?? '')) i++;
    let url = value.slice(start, i);
    const descriptors: string[] = [];
    if (url.endsWith(',')) {
      url = url.replace(/,+$/, '');
    } else {
      // The standard's descriptor tokenizer: a `(` holds commas and spaces until the next `)`,
      // and parentheses don't nest.
      let state: 'descriptor' | 'parens' | 'after' = 'descriptor';
      let current = '';
      for (; ; i++) {
        const c = value[i];
        if (state === 'parens') {
          if (c === undefined) {
            descriptors.push(current);
            break;
          }
          current += c;
          if (c === ')') state = 'descriptor';
        } else if (state === 'after') {
          if (c === undefined) break;
          if (!isHtmlSpace(c)) {
            state = 'descriptor';
            i--;
          }
        } else if (c === undefined || c === ',') {
          if (current) descriptors.push(current);
          if (c === ',') i++;
          break;
        } else if (isHtmlSpace(c)) {
          if (current) descriptors.push(current);
          current = '';
          state = 'after';
        } else {
          current += c;
          if (c === '(') state = 'parens';
        }
      }
    }
    const descriptor = srcsetDescriptor(descriptors);
    if (descriptor !== null) candidates.push({ url, descriptor });
  }
  return candidates;
}

/**
 * A candidate's descriptors as one a browser would use: a width, a density or none. Null when a
 * browser would drop the candidate. A height is valid only beside a width, and browsers ignore it.
 */
function srcsetDescriptor(descriptors: string[]): string | null {
  let width: string | undefined;
  let density: string | undefined;
  let height: string | undefined;
  for (const descriptor of descriptors) {
    const [, number = '', kind] = /^(.*)([wxh])$/.exec(descriptor) ?? [];
    const count = /^[0-9]+$/.test(number) ? Number(number) : 0;
    const float = /^-?(?:[0-9]+(?:\.[0-9]+)?|\.[0-9]+)(?:[eE][-+]?[0-9]+)?$/.test(number);
    if (kind === 'w' && count > 0 && !width && !density) width = descriptor;
    else if (kind === 'x' && float && Number(number) >= 0 && !width && !density && !height) {
      density = descriptor;
    } else if (kind === 'h' && count > 0 && !height && !density) height = descriptor;
    else return null;
  }
  if (height && !width) return null;
  return width ?? density ?? '';
}

/** ASCII whitespace, as HTML defines it. */
const isHtmlSpace = (c: string) =>
  c === ' ' || c === '\t' || c === '\n' || c === '\f' || c === '\r';
