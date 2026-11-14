import { Button } from '@astryxdesign/core/Button';
import { Icon } from '@astryxdesign/core/Icon';
import { IconButton } from '@astryxdesign/core/IconButton';
import {
  borderVars,
  colorVars,
  fontWeightVars,
  spacingVars,
  typeScaleVars,
  typographyVars,
} from '@astryxdesign/core/theme/tokens.stylex';
import * as stylex from '@stylexjs/stylex';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { type Editor as TiptapEditor } from '@tiptap/react';
import { ImagePlus, Paperclip, Trash2 } from 'lucide-react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useMediaQuery } from '../../../shared/useMediaQuery.ts';
import { media, tm } from '../../../app/theme/tokens.stylex.ts';
import { refOf, type Account, type Message, type MessageRef } from '../../mail/core/index.ts';
import { bodyQuery } from '../../mailroom/client/index.ts';
import { useReach } from '../../offline/index.ts';
import {
  isSendable,
  newMessage,
  recipientsOf,
  reopened,
  replyTo,
  type Writing,
} from '../core/session.ts';
import { Editor, placeImages, type EditorProps } from './Editor.tsx';
import { Fields } from './Fields.tsx';
import { Attachments, FilePicker } from './Files.tsx';
import { Formatting, LinkField, type LinkRange } from './Formatting.tsx';
import { ComposerSkeleton, isDocked, Over, sheetStyles } from './sheet.tsx';
import { startDrafting, type Drafting, type SaveState, type Showing } from './drafting.ts';
import { useAutosave } from './useAutosave.ts';
import { useVisibleBand } from './useVisibleBand.ts';
import { useWriting } from './useWriting.ts';

/**
 * What the member asked to write: a new message, a reply, a draft opened again, or what was being
 * written when Send was pressed, back again after Undo took the send back.
 */
export type Compose =
  | { as: 'new'; account: Account }
  | { as: 'reply'; to: Message; all: boolean }
  | { as: 'draft'; draft: Message; conversation: readonly Message[] }
  | { as: 'resumed'; drafting: Drafting; isDocked: boolean };

/** How the workbench's Send reaches the open composer: a time to send at, or now. */
export type Sender = { current: ((at?: string) => void) | undefined };

type ComposerProps = {
  compose: Compose;
  accounts: readonly Account[];
  /**
   * Each draft the message takes, and the one it took the place of, so the reader can leave the
   * draft being written, and one being discarded, out of the conversation it shows.
   */
  onDraft: Showing['onDraft'];
  /**
   * Sends the message, with what was written, and the composer closes at once. Its last save
   * finishes behind it, and the message comes back if the send is undone.
   */
  onSend: (drafting: Drafting, at: string | undefined, writing: Writing) => void;
  /** Filled with the composer's Send while it is open, for the registry's Send and its keys. */
  sender: Sender;
  /** Whether what's written can be sent now, which it can once it is to someone. */
  onSendable: (isSendable: boolean) => void;
  /** Send, split with Send later, drawn from the registry's commands. */
  sendActions: ReactNode;
  /**
   * How the composer lies: on the page, under a conversation or filling the reader, or, on a
   * phone, as a sheet that rises over everything.
   */
  isSheet: boolean;
  /** Closes the composer, which saves what is still unsaved as it goes. */
  onClose: () => void;
};

/**
 * Where the member writes a message, on a sheet of its own: under the conversation for a reply, and
 * filling the reader for a new message. A reply starts at once from what the conversation holds,
 * and takes the parent's Reply-To when its body arrives, unless the member has chosen whom it's to
 * by then. A draft opened again starts once its words and files have loaded.
 */
export function Composer({ compose, ...props }: ComposerProps) {
  // Keyed as the reader keys it, so a parent on screen is already at hand.
  const ref =
    compose.as === 'reply'
      ? refOf(compose.to)
      : compose.as === 'draft'
        ? refOf(compose.draft)
        : undefined;
  const { data: body, isError } = useQuery({
    ...bodyQuery(ref ?? NO_REF),
    enabled: ref !== undefined,
  });
  const start = startOf(compose, props.accounts, body);
  const answering = compose.as === 'reply' ? compose : undefined;
  const account = answering && props.accounts.find(({ id }) => id === answering.to.account);
  const recipients = useMemo(
    () => answering && account && body && recipientsOf(answering.to, body, account, answering.all),
    [answering, account, body],
  );
  if (!start && !isError) {
    return (
      <ComposerSkeleton
        isNew={!isDocked(compose)}
        isSheet={props.isSheet}
        onClose={props.onClose}
      />
    );
  }
  if (!start) {
    const failed = (
      <section
        aria-label="Message"
        {...stylex.props(sheetStyles.sheet, props.isSheet && sheetStyles.risen)}
      >
        <p {...stylex.props(styles.status)}>This message couldn’t be loaded to write from.</p>
      </section>
    );
    return props.isSheet ? <Over onClose={props.onClose}>{failed}</Over> : failed;
  }
  return (
    <Writer
      start={start}
      from={
        // A draft another client wrote as HTML alone opens from its HTML, so no word is lost.
        compose.as === 'draft' && body?.text === undefined && body?.html !== undefined
          ? { html: body.html }
          : { markdown: start.markdown }
      }
      draft={compose.as === 'draft' ? refOf(compose.draft) : undefined}
      resumed={compose.as === 'resumed' ? compose.drafting : undefined}
      recipients={recipients}
      isNew={!start.inReplyTo}
      // A draft that answers mail the index doesn't hold stands alone, but is a reply all the same.
      isReply={start.inReplyTo !== undefined || start.answers !== undefined}
      {...props}
    />
  );
}

const NO_REF: MessageRef = { account: '', path: '', uidValidity: 0, uid: 0 };

function startOf(
  compose: Compose,
  accounts: readonly Account[],
  body: Parameters<typeof reopened>[1] | undefined,
): Writing | undefined {
  switch (compose.as) {
    case 'new':
      return newMessage(compose.account);
    case 'reply': {
      const account = accounts.find(({ id }) => id === compose.to.account);
      return account && replyTo(compose.to, body, account, compose.all);
    }
    case 'draft':
      return body ? reopened(compose.draft, body, compose.conversation) : undefined;
    case 'resumed':
      return compose.drafting.writing;
  }
}

function Writer({
  start,
  from,
  draft,
  resumed,
  recipients,
  isNew,
  isReply,
  accounts,
  onDraft,
  onSend,
  sender,
  onSendable,
  sendActions,
  isSheet,
  onClose,
}: {
  start: Writing;
  from: EditorProps['start'];
  draft: MessageRef | undefined;
  /** The message a send of it was undone for, still being saved as it was. */
  resumed: Drafting | undefined;
  /** Whom a reply goes to once the parent's body says, which waits on the member's own choice. */
  recipients?: Pick<Writing, 'to' | 'cc'> | undefined;
  /** Whether it stands alone, filling the reader with its Subject, rather than under its parent. */
  isNew: boolean;
  /** Whether it answers another message, which names it a reply. */
  isReply: boolean;
} & Omit<ComposerProps, 'compose'>) {
  const message = useWriting(start, recipients);
  const { writing } = message;
  const [editor, setEditor] = useState<TiptapEditor>();
  const queryClient = useQueryClient();
  const [drafting] = useState(
    () => resumed ?? startDrafting(queryClient, { draft, writing: start }),
  );
  const autosave = useAutosave({
    drafting,
    writing,
    edits: message.edits,
    onDraft,
    onNamed: message.nameFiles,
  });
  // Send hands the message over and closes at once, as its last save finishes behind it. A second
  // press before it closes does nothing.
  const isSent = useRef(false);
  const canSend = isSendable(writing);
  const send = (at?: string) => {
    if (isSent.current || !canSend) return;
    isSent.current = true;
    autosave.flush();
    onSend(drafting, at, { ...writing });
    onClose();
  };
  useLayoutEffect(() => {
    sender.current = send;
  });
  useEffect(() => () => void (sender.current = undefined), [sender]);
  useEffect(() => onSendable(canSend), [canSend, onSendable]);
  const discard = () => {
    void drafting.discard();
    onClose();
  };
  const isCoarse = useMediaQuery(media.coarse);
  const isOffline = useReach() !== 'online';
  const [linking, setLinking] = useState<LinkRange>();
  const band = useVisibleBand(isSheet);

  const title = isReply ? 'Reply' : 'New message';
  // On a coarse pointer a tap is the only way in, and a tooltip it left would stay.
  const tip = (label: string) => (isCoarse ? undefined : label);
  // Saving is said in a place of its own, the same size whatever it says, so nothing moves for it.
  const status = (
    <span
      role="status"
      {...stylex.props(
        styles.status,
        isSheet ? [styles.centered, styles.sheetStatus] : styles.grow,
      )}
    >
      {(isOffline ? OFFLINE : SAVED[autosave.state]) || '\u00a0'}
    </span>
  );
  const writer = (
    <section
      aria-label={title}
      {...(isSheet ? { role: 'dialog', 'aria-modal': true } : {})}
      {...stylex.props(
        sheetStyles.sheet,
        isNew && sheetStyles.full,
        isSheet && sheetStyles.risen,
        isSheet && styles.band(band.top, band.bottom),
      )}
    >
      {isSheet && (
        <header {...stylex.props(styles.sheetHeader)}>
          <Button label="Close" variant="ghost" onClick={onClose} />
          <div {...stylex.props(styles.sheetTitle)}>
            <h2 {...stylex.props(styles.title)}>{title}</h2>
            {status}
          </div>
          {sendActions}
        </header>
      )}
      <div {...stylex.props(isSheet && styles.sheetBody)}>
        <Fields
          accounts={accounts}
          account={writing.account}
          typed={message.typed}
          subject={isNew ? writing.subject : undefined}
          isToFocused={start.to.length === 0}
          isSheet={isSheet}
          onAccount={message.sendFrom}
          onAddress={message.address}
          onSubject={message.setSubject}
        />
        <Editor
          start={from}
          onChange={message.write}
          imageUrl={message.imageUrl}
          onFiles={(dropped) => message.take(dropped, true)}
          onEditor={setEditor}
          label={isReply ? 'Reply' : 'Message'}
          isFocused={start.to.length > 0}
        />
        {writing.signature && (
          <pre aria-label="Signature" {...stylex.props(styles.signature)}>
            {`-- \n${writing.signature}`}
          </pre>
        )}
        <Attachments attachments={writing.attachments} onRemove={message.remove} />
      </div>

      {linking && editor && (
        <LinkField editor={editor} range={linking} onDone={() => setLinking(undefined)} />
      )}
      <div
        role="toolbar"
        aria-label="Formatting and files"
        {...stylex.props(styles.toolbar, isSheet && styles.sheetToolbar)}
      >
        {editor && <Formatting editor={editor} tip={tip} onLink={setLinking} />}
        <FilePicker
          label="Insert an image"
          tip={tip}
          icon={ImagePlus}
          accept="image/*"
          onFiles={(picked) => {
            const images = message.take(picked, true);
            if (editor) placeImages(editor, images);
          }}
        />
        <FilePicker
          label="Attach files"
          tip={tip}
          icon={Paperclip}
          onFiles={(picked) => message.take(picked, false)}
        />
        {isSheet ? <span {...stylex.props(styles.grow)} /> : status}
        <IconButton
          label="Discard draft"
          tooltip={tip('Discard draft')}
          icon={<Icon icon={Trash2} />}
          variant="ghost"
          onClick={discard}
        />
        {!isSheet && sendActions}
      </div>
    </section>
  );
  return isSheet ? <Over onClose={onClose}>{writer}</Over> : writer;
}

const SAVED: Record<SaveState, string> = {
  unsaved: '',
  saving: 'Saving…',
  saved: 'Saved to Drafts',
  failed: 'Couldn’t save. Trying again…',
};
/**
 * What the composer says with no network, whatever its save: Send and Send later wait, and what's
 * written saves once the network is back.
 */
const OFFLINE = 'Offline. Send once you’re back.';

const styles = stylex.create({
  // Above the on-screen keyboard, within what the page still shows, so the toolbar stays in reach.
  band: (top: number, bottom: number) => ({
    top: `calc(${tm.safeTop} + ${spacingVars['--spacing-6']} + ${top}px)`,
    bottom: `${bottom}px`,
    paddingBottom: bottom > 0 ? 0 : tm.safeBottom,
  }),
  sheetHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: spacingVars['--spacing-2'],
    padding: spacingVars['--spacing-2'],
    borderBottomWidth: borderVars['--border-width'],
    borderBottomStyle: 'solid',
    borderBottomColor: colorVars['--color-border'],
  },
  // The title on the line of the buttons beside it, and what saving says laid under it, taking no
  // room, so the title stays centered and nothing moves whatever is said.
  sheetTitle: {
    flexGrow: 1,
    minWidth: 0,
    position: 'relative',
    display: 'flex',
    justifyContent: 'center',
  },
  sheetStatus: {
    position: 'absolute',
    top: '100%',
    insetInline: 0,
    // Tight enough to fit under the title within the header, loose enough to keep descenders.
    lineHeight: 1.2,
  },
  title: {
    margin: 0,
    fontSize: typeScaleVars['--text-body-size'],
    fontWeight: fontWeightVars['--font-weight-semibold'],
  },
  // The From chip, on its own line at the top, as far below the header's rule as the To line is
  // below it.
  sheetBody: {
    flexGrow: 1,
    minHeight: 0,
    overflowY: 'auto',
    scrollbarWidth: 'thin',
    overscrollBehavior: 'contain',
    display: 'flex',
    flexDirection: 'column',
    gap: spacingVars['--spacing-2'],
    paddingInline: spacingVars['--spacing-4'],
    paddingBlockStart: spacingVars['--spacing-2'],
  },
  sheetToolbar: {
    flexWrap: 'nowrap',
    paddingInline: spacingVars['--spacing-2'],
    borderTopWidth: borderVars['--border-width'],
    borderTopStyle: 'solid',
    borderTopColor: colorVars['--color-border'],
  },
  signature: {
    margin: 0,
    color: tm.textQuiet,
    fontFamily: typographyVars['--font-family-body'],
    fontSize: typeScaleVars['--text-supporting-size'],
    whiteSpace: 'pre-wrap',
  },
  toolbar: {
    display: 'flex',
    alignItems: 'center',
    gap: spacingVars['--spacing-1'],
    flexWrap: 'wrap',
  },
  status: {
    margin: 0,
    maxWidth: '100%',
    overflow: 'hidden',
    whiteSpace: 'nowrap',
    textOverflow: 'ellipsis',
    color: tm.textQuiet,
    fontSize: typeScaleVars['--text-supporting-size'],
  },
  // A line of its own under the sheet's title, as wide whatever it says.
  centered: {
    alignSelf: 'stretch',
    textAlign: 'center',
  },
  // The room the toolbar has left, whatever is said in it, so its buttons stay where they are.
  grow: {
    flexGrow: 1,
    flexBasis: 0,
    minWidth: 0,
    textAlign: 'end',
    paddingInlineEnd: spacingVars['--spacing-2'],
  },
});
