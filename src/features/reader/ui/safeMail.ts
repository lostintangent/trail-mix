import { colorVars } from '@astryxdesign/core/theme/tokens.stylex';
import * as stylex from '@stylexjs/stylex';
import type { Body, Message, MessageRef } from '../../mail/core/index.ts';
import { imageUrl, partUrl } from '../../mailroom/client/index.ts';
import { colorReader, type DarkPaper } from '../core/colors.ts';
import { refKey, refOf } from './refs.ts';
import { sanitizeMail, type SafeMail } from '../core/sanitize.ts';

/**
 * A message's HTML, sanitized once for each choice about its images and kept. A body never
 * changes for its message, so a message opened again, or prepared ahead while the browser was
 * idle, shows at once.
 */
export function safeMail(
  message: MessageRef,
  body: Body,
  imagesAllowed: boolean,
): SafeMail | undefined {
  if (body.html === undefined) return undefined;
  const key = `${refKey(message)}\u0000${imagesAllowed}`;
  const kept = sanitized.get(key);
  if (kept) return kept;
  const parts = new Map(
    body.attachments.flatMap(({ id, contentId }) =>
      contentId ? [[contentId, absolute(partUrl(refOf(message), id))] as const] : [],
    ),
  );
  const mail = sanitizeMail(
    body.html,
    {
      part: (contentId) => parts.get(contentId),
      remote: imagesAllowed ? (url) => absolute(imageUrl(url)) : undefined,
    },
    darkPaper(),
  );
  sanitized.set(key, mail);
  if (sanitized.size > KEPT) sanitized.delete(sanitized.keys().next().value ?? '');
  return mail;
}

/** Whether the member allowed this sender's remote images on the message's account. */
export function imagesAllowed(message: Message, allowImagesFrom: string[]): boolean {
  const sender = message.from.email.toLowerCase();
  return allowImagesFrom.some((email) => email.toLowerCase() === sender);
}

/** How many sanitized messages are kept, oldest dropped first. */
const KEPT = 64;
const sanitized = new Map<string, SafeMail>();

/** The frame's policy names exact URLs, so the ones it loads are absolute. */
const absolute = (url: string) => new URL(url, location.origin).href;

/**
 * The dark theme's paper and ink, which the colors mail sets are lifted to read on, and the light
 * theme's ink, which text on mail's own light colors takes. They are the theme's own, read once
 * from an element in each scheme, whichever theme shows now.
 */
export function darkPaper(): DarkPaper {
  if (dark) return dark;
  const read = colorReader();
  const [inDark, inLight] = [styles.dark, styles.light].map((scheme) => {
    const probe = document.createElement('div');
    probe.className = stylex.props(styles.probe, scheme).className ?? '';
    document.body.appendChild(probe);
    const computed = getComputedStyle(probe);
    const seen = { paper: read(computed.backgroundColor), ink: read(computed.color) };
    probe.remove();
    return seen;
  });
  const [paper, ink, lightInk] = [inDark?.paper, inDark?.ink, inLight?.ink];
  if (!paper || !ink || !lightInk) throw new Error('The theme’s paper and inks can’t be read');
  dark = { paper: paper.rgb, ink: ink.rgb, lightInk: lightInk.rgb };
  return dark;
}

let dark: DarkPaper | undefined;

const styles = stylex.create({
  probe: {
    position: 'absolute',
    visibility: 'hidden',
    backgroundColor: colorVars['--color-background-card'],
    color: colorVars['--color-text-primary'],
  },
  dark: {
    colorScheme: 'dark',
  },
  light: {
    colorScheme: 'light',
  },
});
