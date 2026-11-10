import { Button } from '@astryxdesign/core/Button';
import { Icon } from '@astryxdesign/core/Icon';
import { IconButton } from '@astryxdesign/core/IconButton';
import {
  borderVars,
  colorVars,
  fontWeightVars,
  radiusVars,
  spacingVars,
  typeScaleVars,
  typographyVars,
} from '@astryxdesign/core/theme/tokens.stylex';
import * as stylex from '@stylexjs/stylex';
import { Code, Ellipsis, FileText, ImageIcon, ImageOff } from 'lucide-react';
import { useMemo, useState } from 'react';
import { media, tm } from '../../../app/theme/tokens.stylex.ts';
import type { Account, Address, Body, Message, MessageRef } from '../../mail/core/index.ts';
import { foldQuote } from '../core/quotes.ts';
import { sanitizeMail, type SafeMail } from '../core/sanitize.ts';
import { MessageFrame } from './MessageFrame.tsx';
import { PlainText } from './PlainText.tsx';
import { SourceDialog } from './SourceDialog.tsx';

/** Where a message's bytes are served: its source, its parts, and remote images through the proxy. */
export type MessageUrls = {
  source: (ref: MessageRef) => string;
  part: (ref: MessageRef, attachmentId: string) => string;
  image: (url: string) => string;
};

export type MessageSheetProps = {
  message: Message;
  /** Undefined until the body is fetched. */
  body: Body | undefined;
  account: Account;
  urls: MessageUrls;
  /** From now on, this sender's remote images load. */
  onAllowImages: (sender: string) => void;
};

/** One open message, on its own sheet of paper: who sent it, what it says, and what it carries. */
export function MessageSheet({ message, body, account, urls, onAllowImages }: MessageSheetProps) {
  const sender = message.from.email.toLowerCase();
  const [showOnce, setShowOnce] = useState(false);
  const allowed =
    showOnce || account.allowImagesFrom.some((email) => email.toLowerCase() === sender);
  const [quotes, setQuotes] = useState<'folded' | 'shown'>('folded');
  const [viewingSource, setViewingSource] = useState(false);

  const mail = useSafeMail(message, body, allowed, urls);
  const text = useMemo(
    () => (body && !body.html && body.text !== undefined ? foldQuote(body.text) : undefined),
    [body],
  );
  const hasQuote = Boolean(mail?.quote || text?.quote);
  const inline = new Set(mail?.inlineParts);
  const attachments = (body?.attachments ?? []).filter(
    ({ contentId }) => !contentId || !inline.has(contentId),
  );

  return (
    <article
      aria-label={`Message from ${displayName(message.from)}`}
      {...stylex.props(styles.sheet, mail?.ownColors && styles.fixedPaper)}
    >
      <header {...stylex.props(styles.from)}>
        <span aria-hidden {...stylex.props(styles.avatar)}>
          {initials(message.from)}
        </span>
        <div {...stylex.props(styles.who)}>
          <strong {...stylex.props(styles.name)}>{displayName(message.from)}</strong>
          <small {...stylex.props(styles.quiet)}>
            {recipients(message, account)} ·{' '}
            <time dateTime={message.date}>{when(message.date)}</time>
          </small>
        </div>
        <IconButton
          label="View source"
          icon={<Icon icon={Code} />}
          variant="ghost"
          onClick={() => setViewingSource(true)}
        />
      </header>

      {mail?.blockedImages && (
        <div role="status" {...stylex.props(styles.images)}>
          <Icon icon={ImageOff} size="sm" color="secondary" />
          <span {...stylex.props(styles.imagesText)}>
            Images from {displayName(message.from)} are hidden.
          </span>
          <Button label="Show" variant="ghost" size="sm" onClick={() => setShowOnce(true)} />
          <Button
            label="Always show"
            tooltip={`Always show images from ${message.from.email}`}
            variant="ghost"
            size="sm"
            onClick={() => onAllowImages(sender)}
          />
        </div>
      )}

      {mail ? (
        <MessageFrame
          mail={mail}
          quotes={quotes}
          title={`Message from ${displayName(message.from)}`}
        />
      ) : text ? (
        <PlainText text={text.text} />
      ) : (
        <p {...stylex.props(styles.quiet)}>{body ? 'This message is empty.' : 'Opening…'}</p>
      )}

      {hasQuote && (
        <button
          type="button"
          aria-expanded={quotes === 'shown'}
          onClick={() => setQuotes(quotes === 'shown' ? 'folded' : 'shown')}
          {...stylex.props(styles.quoteToggle)}
        >
          <Icon icon={Ellipsis} size="sm" />
          {quotes === 'shown' ? 'Hide quoted text' : 'Quoted text'}
        </button>
      )}
      {text?.quote && quotes === 'shown' && <PlainText text={text.quote} />}

      {attachments.length > 0 && (
        <ul aria-label="Attachments" {...stylex.props(styles.attachments)}>
          {attachments.map((attachment) => (
            <li key={attachment.id}>
              <a
                href={urls.part(message, attachment.id)}
                target="_blank"
                rel="noopener noreferrer"
                download={attachment.name}
                {...stylex.props(styles.attachment)}
              >
                <Icon
                  icon={attachment.type.startsWith('image/') ? ImageIcon : FileText}
                  size="sm"
                  color="secondary"
                />
                <span {...stylex.props(styles.attachmentName)}>{attachment.name}</span>
                <span {...stylex.props(styles.quiet)}>{size(attachment.size)}</span>
              </a>
            </li>
          ))}
        </ul>
      )}

      {viewingSource && body && (
        <SourceDialog
          message={message}
          headers={body.headers}
          url={urls.source(message)}
          onClose={() => setViewingSource(false)}
        />
      )}
    </article>
  );
}

/**
 * The message's HTML, sanitized once for each choice about its images. Bodies never change for a
 * ref, so a conversation opened again shows what was already sanitized.
 */
function useSafeMail(
  message: Message,
  body: Body | undefined,
  allowed: boolean,
  urls: MessageUrls,
): SafeMail | undefined {
  return useMemo(() => {
    const html = body?.html;
    if (html === undefined) return undefined;
    const key = `${refKey(message)}\u0000${allowed}`;
    const cached = sanitized.get(key);
    if (cached) return cached;
    const parts = new Map(
      body?.attachments.flatMap(({ id, contentId }) =>
        contentId ? [[contentId, absolute(urls.part(message, id))] as const] : [],
      ),
    );
    const mail = sanitizeMail(html, {
      part: (contentId) => parts.get(contentId),
      remote: allowed ? (url) => absolute(urls.image(url)) : undefined,
    });
    sanitized.set(key, mail);
    if (sanitized.size > SANITIZED_KEPT) sanitized.delete(sanitized.keys().next().value ?? '');
    return mail;
  }, [message, body, allowed, urls]);
}

/** How many sanitized messages stay ready, oldest dropped first. */
const SANITIZED_KEPT = 64;
const sanitized = new Map<string, SafeMail>();

export const refKey = ({ account, path, uidValidity, uid }: MessageRef) =>
  [account, path, uidValidity, uid].join('\u0000');

/** The frame's policy names exact URLs, so the ones it loads are absolute. */
const absolute = (url: string) => new URL(url, location.origin).href;

export function displayName({ name, email }: Address): string {
  return name?.trim() || email;
}

function initials(address: Address): string {
  const words = displayName(address)
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
  const letters = words.length > 1 ? [words[0], words.at(-1)] : [words[0]?.slice(0, 2)];
  return letters
    .map((word) => word?.[0] ?? '')
    .join('')
    .toUpperCase();
}

function recipients(message: Message, account: Account): string {
  const everyone = [...message.to, ...message.cc];
  const mine = account.address.toLowerCase();
  const names = everyone.map((address) =>
    address.email.toLowerCase() === mine ? 'you' : displayName(address),
  );
  if (names.length === 0) return 'to no one';
  const shown = names.includes('you') ? ['you', ...names.filter((n) => n !== 'you')] : names;
  if (shown.length <= 2) return `to ${shown.join(' and ')}`;
  return `to ${shown[0]} and ${shown.length - 1} others`;
}

const TIME = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const DAY = new Intl.DateTimeFormat(undefined, {
  weekday: 'short',
  month: 'short',
  day: 'numeric',
});

export function when(iso: string, now = new Date()): string {
  const date = new Date(iso);
  if (date.toDateString() === now.toDateString()) return TIME.format(date);
  return `${DAY.format(date)}, ${TIME.format(date)}`;
}

function size(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`;
  if (bytes < 1_000_000) return `${Math.round(bytes / 1000)} KB`;
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

const styles = stylex.create({
  sheet: {
    display: 'flex',
    flexDirection: 'column',
    gap: spacingVars['--spacing-2'],
    paddingBlock: spacingVars['--spacing-3'],
    paddingInline: spacingVars['--spacing-4'],
    backgroundColor: colorVars['--color-background-card'],
    color: colorVars['--color-text-primary'],
    borderRadius: tm.sheetRadius,
    boxShadow: tm.sheetEdge,
    outline: {
      default: null,
      [media.forcedColors]: `${borderVars['--border-width']} solid CanvasText`,
    },
  },
  // Mail that sets its own colors is written for light paper, and stays on it.
  fixedPaper: {
    colorScheme: 'light',
    backgroundColor: tm.paperFixed,
  },
  from: {
    display: 'flex',
    alignItems: 'center',
    gap: spacingVars['--spacing-2'],
  },
  avatar: {
    display: 'grid',
    placeItems: 'center',
    flexShrink: 0,
    width: tm.target,
    height: tm.target,
    borderRadius: radiusVars['--radius-full'],
    backgroundColor: colorVars['--color-accent-muted'],
    color: colorVars['--color-text-accent'],
    fontSize: typeScaleVars['--text-supporting-size'],
    fontWeight: fontWeightVars['--font-weight-semibold'],
  },
  who: {
    display: 'flex',
    flexDirection: 'column',
    minWidth: 0,
    flexGrow: 1,
  },
  name: {
    fontWeight: fontWeightVars['--font-weight-semibold'],
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  quiet: {
    color: tm.textQuiet,
    fontSize: typeScaleVars['--text-supporting-size'],
  },
  images: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: spacingVars['--spacing-1'],
    paddingInline: spacingVars['--spacing-2'],
    paddingBlock: spacingVars['--spacing-1'],
    borderRadius: radiusVars['--radius-element'],
    backgroundColor: colorVars['--color-background-muted'],
    color: colorVars['--color-text-secondary'],
    fontSize: typeScaleVars['--text-supporting-size'],
  },
  imagesText: {
    flexGrow: 1,
  },
  quoteToggle: {
    alignSelf: 'flex-start',
    display: 'inline-flex',
    alignItems: 'center',
    gap: spacingVars['--spacing-1'],
    minHeight: tm.target,
    paddingInline: spacingVars['--spacing-1'],
    borderWidth: 0,
    borderRadius: radiusVars['--radius-element'],
    backgroundColor: { default: 'transparent', ':hover': colorVars['--color-overlay-hover'] },
    color: tm.textQuiet,
    fontFamily: typographyVars['--font-family-body'],
    fontSize: typeScaleVars['--text-supporting-size'],
    cursor: 'pointer',
  },
  attachments: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: spacingVars['--spacing-2'],
    margin: 0,
    padding: 0,
    listStyle: 'none',
  },
  attachment: {
    display: 'flex',
    alignItems: 'center',
    gap: spacingVars['--spacing-1-5'],
    minHeight: tm.target,
    maxWidth: '100%',
    paddingInline: spacingVars['--spacing-2'],
    borderRadius: radiusVars['--radius-element'],
    boxShadow: `0 0 0 ${borderVars['--border-width']} ${colorVars['--color-border']}`,
    color: colorVars['--color-text-primary'],
    textDecoration: 'none',
    backgroundColor: { default: 'transparent', ':hover': colorVars['--color-overlay-hover'] },
  },
  attachmentName: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
});
