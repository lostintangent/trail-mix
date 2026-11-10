/**
 * The address a link the member types or pastes goes to: a web address, with `https://` added when
 * it was left off, or a mail address, as `mailto:`. Anything else, such as a `javascript:` address
 * or words with spaces, makes no link.
 */
export function linkOf(typed: string): string | undefined {
  const text = typed.trim();
  if (text === '' || /\s/.test(text)) return undefined;
  if (/^mailto:/i.test(text)) return isMail(text.slice('mailto:'.length)) ? text : undefined;
  if (/^https?:\/\//i.test(text)) return isWeb(text) ? text : undefined;
  if (isMail(text)) return `mailto:${text}`;
  // A scheme of any other kind isn't a web address left without its own.
  if (/^[a-z][a-z\d+.-]*:/i.test(text) && !/^[^:]+:\d/.test(text)) return undefined;
  return text.includes('.') && isWeb(`https://${text}`) ? `https://${text}` : undefined;
}

const isMail = (text: string) => /^[^@\s/:]+@[^@\s/:]+\.[^@\s/:]+$/.test(text);

function isWeb(text: string): boolean {
  try {
    const url = new URL(text);
    return (url.protocol === 'https:' || url.protocol === 'http:') && url.hostname.includes('.');
  } catch {
    return false;
  }
}
