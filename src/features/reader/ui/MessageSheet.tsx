import { Button } from '@astryxdesign/core/Button';
import { DropdownMenu } from '@astryxdesign/core/DropdownMenu';
import { Icon } from '@astryxdesign/core/Icon';
import {
  borderVars,
  colorVars,
  focusVars,
  radiusVars,
  spacingVars,
  typeScaleVars,
  typographyVars,
} from '@astryxdesign/core/theme/tokens.stylex';
import * as stylex from '@stylexjs/stylex';
import { Ellipsis, FileText, ImageIcon, ImageOff } from 'lucide-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { tm } from '../../../app/theme/tokens.stylex.ts';
import { CommandButton, type Command } from '../../commands/index.ts';
import type { Account, Address, Message } from '../../mail/core/index.ts';
import { accountsQuery, bodyQuery, mailroom, partUrl } from '../../mailroom/client/index.ts';
import { foldQuote } from '../core/quotes.ts';
import { sheetStyles } from './layout.ts';
import { MessageFrame } from './MessageFrame.tsx';
import { PlainText } from './PlainText.tsx';
import { BodySkeleton } from './skeletons.tsx';
import { refOf } from './refs.ts';
import { imagesAllowed, safeMail } from './safeMail.ts';

export type MessageSheetProps = {
  message: Message;
  account: Account;
  /** What can be done with this message: a reply, beside its sender, and the rest in a menu. */
  actions?: readonly Command[];
};

/** One open message, on its own sheet of paper: who sent it, what it says, and what it carries. */
export function MessageSheet({ message, account, actions = [] }: MessageSheetProps) {
  const ref = refOf(message);
  const { data: body, isError, refetch } = useQuery(bodyQuery(ref));
  const [showOnce, setShowOnce] = useState(false);
  const allowed = showOnce || imagesAllowed(message, account.allowImagesFrom);
  const allowImages = useAllowImages(account);
  const [quotes, setQuotes] = useState<'folded' | 'shown'>('folded');
  const reply = actions.find(({ id }) => id === 'message.reply');
  const more = actions.filter((action) => action !== reply && action.isEnabled !== false);

  const mail = useMemo(() => body && safeMail(message, body, allowed), [message, body, allowed]);
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
      {...stylex.props(sheetStyles.sheet, mail?.paper === 'light' && styles.fixedPaper)}
    >
      <header {...stylex.props(sheetStyles.from)}>
        <span aria-hidden {...stylex.props(sheetStyles.avatar)}>
          {initials(message.from)}
        </span>
        <div {...stylex.props(sheetStyles.who)}>
          <strong {...stylex.props(sheetStyles.name)}>{displayName(message.from)}</strong>
          <small {...stylex.props(sheetStyles.quiet)}>
            {recipients(message, account)} ·{' '}
            <time dateTime={message.date}>{when(message.date)}</time>
          </small>
        </div>
        {reply && <CommandButton command={reply} />}
        {more.length > 0 && (
          <DropdownMenu
            button={{
              label: 'More for this message',
              tooltip: 'More',
              icon: <Icon icon={Ellipsis} />,
              isIconOnly: true,
              variant: 'ghost',
            }}
            hasChevron={false}
            items={more.map(({ id, title, run }) => ({
              id,
              label: title,
              onClick: () => void run(),
            }))}
          />
        )}
      </header>

      {mail?.blockedImages && (
        <div role="status" {...stylex.props(styles.images)}>
          <Icon icon={ImageOff} size="sm" color="secondary" />
          <span {...stylex.props(styles.imagesText)}>
            Images from {displayName(message.from)} are hidden.
          </span>
          <span {...stylex.props(styles.imagesActions)}>
            <Button label="Show" variant="ghost" size="sm" onClick={() => setShowOnce(true)} />
            <Button
              label="Always show"
              tooltip={`Always show images from ${message.from.email}`}
              variant="ghost"
              size="sm"
              onClick={() => {
                setShowOnce(true);
                allowImages(message.from.email.toLowerCase());
              }}
            />
          </span>
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
      ) : isError ? (
        <p role="alert" {...stylex.props(sheetStyles.quiet)}>
          This message could not be opened.{' '}
          <Button label="Try again" variant="ghost" size="sm" onClick={() => void refetch()} />
        </p>
      ) : body ? (
        <p {...stylex.props(sheetStyles.quiet)}>This message is empty.</p>
      ) : (
        <BodySkeleton />
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
                href={partUrl(ref, attachment.id)}
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
                <span {...stylex.props(sheetStyles.quiet)}>{size(attachment.size)}</span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </article>
  );
}

/**
 * Allows a sender's remote images on an account. The account shows it at once, and the accounts
 * snapshot is refetched if the Mailroom refuses, so the change visibly undoes itself.
 */
function useAllowImages(account: Account) {
  const queryClient = useQueryClient();
  return (sender: string) => {
    queryClient.setQueryData(accountsQuery.queryKey, (accounts) =>
      accounts?.map((each) =>
        each.id === account.id
          ? { ...each, allowImagesFrom: [...new Set([...each.allowImagesFrom, sender])] }
          : each,
      ),
    );
    mailroom.allowImages(account.id, sender).catch(() => {
      void queryClient.invalidateQueries({ queryKey: accountsQuery.queryKey });
    });
  };
}

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

const FOCUS_RING = `${focusVars['--focus-outline-width']} ${focusVars['--focus-outline-style']} ${focusVars['--focus-outline-color']}`;

const styles = stylex.create({
  // Mail that paints its own backgrounds is written for light paper, and stays on it.
  fixedPaper: {
    colorScheme: 'light',
    backgroundColor: tm.paperFixed,
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
  // The two choices wrap as one, so they stay together on a narrow sheet.
  imagesActions: {
    display: 'flex',
    marginInlineStart: 'auto',
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
    outline: { default: null, ':focus-visible': FOCUS_RING },
    outlineOffset: focusVars['--focus-outline-offset'],
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
    outline: { default: null, ':focus-visible': FOCUS_RING },
    outlineOffset: focusVars['--focus-outline-offset'],
  },
  attachmentName: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
});
