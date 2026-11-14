import { Button } from '@astryxdesign/core/Button';
import { DropdownMenu } from '@astryxdesign/core/DropdownMenu';
import { Icon } from '@astryxdesign/core/Icon';
import { ToggleButton } from '@astryxdesign/core/ToggleButton';
import {
  borderVars,
  colorVars,
  radiusVars,
  spacingVars,
  typeScaleVars,
  typographyVars,
} from '@astryxdesign/core/theme/tokens.stylex';
import * as stylex from '@stylexjs/stylex';
import { Ellipsis, FileText, ImageIcon, ImageOff, ShieldCheck, Sun } from 'lucide-react';
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { SenderAvatar } from '../../../app/theme/SenderAvatar.tsx';
import { focusRing, tm } from '../../../app/theme/tokens.stylex.ts';
import { sizeText } from '../../../shared/size.ts';
import { CommandButton, type Command } from '../../commands/index.ts';
import {
  isReasonOf,
  listed,
  refOf,
  type Account,
  type Address,
  type Message,
} from '../../mail/core/index.ts';
import {
  accountsQuery,
  bodyQuery,
  avatarUrl,
  mailroom,
  partUrl,
} from '../../mailroom/client/index.ts';
import { foldQuote } from '../core/quotes.ts';
import { setLightPaper, useDarkTheme } from './lightPaper.ts';
import { sheetStyles } from './layout.ts';
import { MessageFrame } from './MessageFrame.tsx';
import { PlainText } from './PlainText.tsx';
import { BodySkeleton } from './skeletons.tsx';
import { safeMail } from './safeMail.ts';
import { Unsubscribe } from './Unsubscribe.tsx';

type MessageSheetProps = {
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
  const allowed = showOnce || listed(message.from.email, account.allowImagesFrom);
  const queryClient = useQueryClient();
  // In the dark theme, the member may show someone else's mail on light paper, as designed. The
  // control stands from the first frame, so the header holds still when the body arrives.
  const isDark = useDarkTheme();
  const isOwn = listed(message.from.email, [account.address]);
  const offersLightPaper = isDark && !isOwn;
  const lightPaper = offersLightPaper && listed(message.from.email, account.lightPaperFrom);
  const [quotes, setQuotes] = useState<'folded' | 'shown'>('folded');
  const reply = actions.find(({ id }) => id === 'message.reply');
  const more = actions.filter((action) => action !== reply && action.isEnabled !== false);

  const mail = useMemo(() => body && safeMail(message, body, allowed), [message, body, allowed]);
  const text = useMemo(
    () => (body && !body.html && body.text !== undefined ? foldQuote(body.text) : undefined),
    [body],
  );
  const hasQuote = Boolean(mail?.quote || text?.quote);
  const trackers = mail?.trackers
    ? `${mail.trackers} ${mail.trackers === 1 ? 'tracker' : 'trackers'} blocked`
    : undefined;
  const shownTrackers = mail?.blockedImages ? undefined : trackers;
  const offer = body?.unsubscribe;
  const inline = new Set(mail?.inlineParts);
  const attachments = (body?.attachments ?? []).filter(
    ({ contentId }) => !contentId || !inline.has(contentId),
  );

  return (
    <article
      aria-label={`Message from ${displayName(message.from)}`}
      {...stylex.props(
        sheetStyles.sheet,
        (mail?.paper === 'light' || lightPaper) && styles.fixedPaper,
      )}
    >
      <header {...stylex.props(sheetStyles.from)}>
        <SenderAvatar
          name={displayName(message.from)}
          picture={message.avatar && avatarUrl(message.avatar)}
        />
        <div {...stylex.props(sheetStyles.who)}>
          <strong {...stylex.props(sheetStyles.name)}>{displayName(message.from)}</strong>
          {/* The time stays whole, and the recipients give way to it. */}
          <small {...stylex.props(sheetStyles.quiet, styles.line)}>
            <span {...stylex.props(styles.recipients)}>{recipients(message, account)}</span>
            <span aria-hidden>·</span>
            <time dateTime={message.date} {...stylex.props(styles.when)}>
              {when(message.date)}
            </time>
          </small>
        </div>
        {offersLightPaper && (
          <ToggleButton
            label="Light paper"
            tooltip={
              mail?.paper === 'light'
                ? 'This message’s colors can’t be darkened, so it stays on light paper'
                : lightPaper
                  ? `Darken mail from ${message.from.email} again`
                  : `Show mail from ${message.from.email} on light paper`
            }
            icon={<Icon icon={Sun} />}
            isIconOnly
            isPressed={mail?.paper === 'light' || lightPaper}
            isDisabled={mail?.paper === 'light'}
            onPressedChange={(on) =>
              setLightPaper(queryClient, { account: account.id, sender: message.from.email, on })
            }
          />
        )}
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
          <span {...stylex.props(styles.imagesText)}>
            <Icon icon={ImageOff} size="sm" color="secondary" />
            <span>
              Images from {displayName(message.from)} are hidden.
              {trackers && (
                <>
                  {' '}
                  <span {...stylex.props(styles.whole)}>{trackers}.</span>
                </>
              )}
            </span>
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
                allowImages(queryClient, account.id, message.from.email.toLowerCase());
              }}
            />
          </span>
        </div>
      )}
      {/* What the reader did and can do about the sender, quietly: the trackers it blocked, once
      the note on images no longer counts them, and a list's offer to unsubscribe. */}
      {(shownTrackers || offer) && (
        <div {...stylex.props(styles.quietLine, !shownTrackers && styles.quietLineAtOffer)}>
          {shownTrackers && (
            <span {...stylex.props(styles.shield)}>
              <Icon icon={ShieldCheck} size="sm" color="secondary" />
              {shownTrackers}
            </span>
          )}
          {offer && <Unsubscribe message={ref} address={offer} />}
        </div>
      )}

      {mail ? (
        <MessageFrame
          mail={mail}
          quotes={quotes}
          title={`Message from ${displayName(message.from)}`}
          isLightPaper={lightPaper}
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
                <span {...stylex.props(sheetStyles.quiet)}>{sizeText(attachment.size)}</span>
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
function allowImages(queryClient: QueryClient, account: Account['id'], sender: string) {
  queryClient.setQueryData(accountsQuery.queryKey, (accounts) =>
    accounts?.map((each) =>
      each.id === account
        ? { ...each, allowImagesFrom: [...new Set([...each.allowImagesFrom, sender])] }
        : each,
    ),
  );
  mailroom.allowImages(account, sender).catch(() => {
    void queryClient.invalidateQueries({ queryKey: accountsQuery.queryKey });
  });
}

export function displayName({ name, email }: Address): string {
  return name?.trim() || email;
}

function recipients(message: Message, account: Account): string {
  const everyone = [...message.to, ...message.cc].filter(
    (address) => !isReasonOf(message, address),
  );
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

const styles = stylex.create({
  line: {
    display: 'flex',
    gap: spacingVars['--spacing-1'],
    minWidth: 0,
    whiteSpace: 'nowrap',
  },
  recipients: {
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  when: {
    flexShrink: 0,
  },
  // Light paper: mail written for it, or a sender's the member chose to show on it.
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
  // The icon stays beside the words as they wrap, and the choices wrap under them.
  imagesText: {
    display: 'flex',
    alignItems: 'center',
    flexGrow: 1,
    gap: spacingVars['--spacing-1'],
  },
  // The count of trackers wraps as one phrase.
  whole: {
    whiteSpace: 'nowrap',
  },
  // Lined up with the words of the note on images, without its box.
  quietLine: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: spacingVars['--spacing-3'],
    paddingInline: spacingVars['--spacing-2'],
    color: colorVars['--color-text-secondary'],
    fontSize: typeScaleVars['--text-supporting-size'],
  },
  // Led by the offer, whose button lines its box up with the note's.
  quietLineAtOffer: {
    paddingInline: 0,
  },
  shield: {
    display: 'flex',
    alignItems: 'center',
    gap: spacingVars['--spacing-1'],
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
    outline: { default: null, ':focus-visible': focusRing.line },
    outlineOffset: focusRing.outside,
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
    outline: { default: null, ':focus-visible': focusRing.line },
    outlineOffset: focusRing.outside,
  },
  attachmentName: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
});
