import { Button } from '@astryxdesign/core/Button';
import { Icon } from '@astryxdesign/core/Icon';
import { IconButton } from '@astryxdesign/core/IconButton';
import {
  borderVars,
  colorVars,
  radiusVars,
  spacingVars,
  typeScaleVars,
  typographyVars,
  shadowVars,
} from '@astryxdesign/core/theme/tokens.stylex';
import * as stylex from '@stylexjs/stylex';
import { useQuery } from '@tanstack/react-query';
import { useEditorState, type Editor as TiptapEditor } from '@tiptap/react';
import { Bold, Code, ImagePlus, Italic, Paperclip, Trash2, X } from 'lucide-react';
import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { StampDot } from '../../../app/theme/StampDot.tsx';
import { useMediaQuery } from '../../../shared/useMediaQuery.ts';
import { media, tm } from '../../../app/theme/tokens.stylex.ts';
import type { Account, Message, MessageRef } from '../../mail/core/index.ts';
import { bodyQuery, partUrl } from '../../mailroom/client/index.ts';
import { contentIdFor } from '../core/draft.ts';
import {
  addressesOf,
  addressText,
  newMessage,
  reopened,
  replyTo,
  type Attached,
  type Writing,
} from '../core/session.ts';
import { Editor, type EditorProps } from './Editor.tsx';
import { useAutosave, type SaveState } from './useAutosave.ts';

/**
 * What the member asked to write: a new message, a reply, a draft opened again, or what was being
 * written when Send was pressed, back again after Undo took the send back.
 */
export type Compose =
  | { as: 'new'; account: Account }
  | { as: 'reply'; to: Message; all: boolean }
  | { as: 'draft'; draft: Message; conversation: readonly Message[] }
  | { as: 'resumed'; writing: Writing; draft: MessageRef; isDocked: boolean };

/** How the workbench's Send reaches the open composer: a time to send at, or now. */
export type Sender = { current: ((at?: string) => void) | undefined };

export type ComposerProps = {
  compose: Compose;
  accounts: readonly Account[];
  /**
   * Each draft a save makes, and the one it replaced, so the reader can leave the draft being
   * written out of the conversation it shows.
   */
  onDraft?: (saved: MessageRef, replaced: MessageRef | undefined) => void;
  /**
   * Sends the draft once everything written is saved, with what was written, which comes back
   * if the send is undone. Then the composer closes.
   */
  onSend: (draft: MessageRef, at: string | undefined, writing: Writing) => void;
  /** Filled with the composer's Send while it is open, for the registry's Send and its keys. */
  sender: Sender;
  /** Whether what's written can be sent now, which it can once it is to someone. */
  onSendable: (isSendable: boolean) => void;
  /** The Send and Send later buttons, drawn from the registry's commands. */
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
 * filling the reader for a new message. It starts once what it needs has loaded: the parent's
 * headers for a reply, or the draft's words and files.
 */
export function Composer({ compose, ...props }: ComposerProps) {
  const ref =
    compose.as === 'reply' ? compose.to : compose.as === 'draft' ? compose.draft : undefined;
  const { data: body, isError } = useQuery({
    ...bodyQuery(ref ?? NO_REF),
    enabled: ref !== undefined,
  });
  const start = startOf(compose, props.accounts, body);
  if (!start) {
    const opening = (
      <section
        aria-label="Message"
        aria-busy={!isError}
        {...stylex.props(styles.sheet, props.isSheet && styles.risen)}
      >
        <p {...stylex.props(styles.status)}>
          {isError ? 'This message couldn’t be loaded to write from.' : 'Opening…'}
        </p>
      </section>
    );
    return props.isSheet ? <Over onClose={props.onClose}>{opening}</Over> : opening;
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
      draft={compose.as === 'draft' || compose.as === 'resumed' ? refOf(compose.draft) : undefined}
      isNew={compose.as === 'new' || !start.inReplyTo}
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
      return account && body ? replyTo(compose.to, body, account, compose.all) : undefined;
    }
    case 'draft':
      return body ? reopened(compose.draft, body, compose.conversation) : undefined;
    case 'resumed':
      return compose.writing;
  }
}

function Writer({
  start,
  from,
  draft,
  isNew,
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
  isNew: boolean;
} & Omit<ComposerProps, 'compose'>) {
  const [writing, setWriting] = useState(start);
  const [edits, setEdits] = useState(0);
  const [fields, setFields] = useState(() => ({
    to: addressText(start.to),
    cc: addressText(start.cc),
    bcc: addressText(start.bcc),
  }));
  const [hasCopies, setHasCopies] = useState(start.cc.length + start.bcc.length > 0);
  const [editor, setEditor] = useState<TiptapEditor>();
  const fileUrl = useFileUrls();
  const id = useId();
  const autosave = useAutosave({
    writing,
    edits,
    draft,
    onSaved: (saved, replaced, named) => {
      setWriting((was) => ({
        ...was,
        attachments: was.attachments.map((attached) => named.get(attached) ?? attached),
      }));
      onDraft?.(saved, replaced);
    },
  });

  const edit = (change: (was: Writing) => Partial<Writing>) => {
    setWriting((was) => ({ ...was, ...change(was) }));
    setEdits((count) => count + 1);
  };
  const setAddresses = (field: 'to' | 'cc' | 'bcc', text: string) => {
    setFields((was) => ({ ...was, [field]: text }));
    edit(() => ({ [field]: addressesOf(text) }));
  };
  const take = (files: File[], inline: boolean) => {
    const added: Attached[] = files.map((file) =>
      inline && file.type.startsWith('image/')
        ? { file, contentId: contentIdFor(crypto.randomUUID()) }
        : { file },
    );
    edit((was) => ({ attachments: [...was.attachments, ...added] }));
    return added.flatMap((attached) =>
      'file' in attached && attached.contentId
        ? [{ file: attached.file, contentId: attached.contentId }]
        : [],
    );
  };
  const imageUrl = (contentId: string) => {
    const found = writing.attachments.find((attached) => attached.contentId === contentId);
    if (!found) return undefined;
    return 'file' in found ? fileUrl(found.file) : partUrl(found.in, found.id);
  };
  // Send saves what's left to save, then hands the draft over and closes. A second press while the
  // first is saving does nothing.
  const isSending = useRef(false);
  const isSendable = writing.to.length + writing.cc.length + writing.bcc.length > 0;
  const send = async (at?: string) => {
    if (isSending.current || !isSendable) return;
    isSending.current = true;
    try {
      const saved = await autosave.settle();
      onSend(saved, at, { ...writing });
      onClose();
    } catch {
      // The status says the save failed, and the save is tried again.
    } finally {
      isSending.current = false;
    }
  };
  useLayoutEffect(() => {
    sender.current = (at) => void send(at);
  });
  useEffect(() => () => void (sender.current = undefined), [sender]);
  useEffect(() => onSendable(isSendable), [isSendable, onSendable]);
  const discard = () => {
    void autosave.discard();
    onClose();
  };
  const account = accounts.find((each) => each.id === writing.account);
  const files = writing.attachments.filter((attached) => attached.contentId === undefined);
  const isCoarse = useMediaQuery(media.coarse);

  const title = isNew ? 'New message' : 'Reply';
  // On a coarse pointer a tap is the only way in, and a tooltip it left would stay.
  const tip = (label: string) => (isCoarse ? undefined : label);
  const status = (
    <span role="status" {...stylex.props(styles.status, !isSheet && styles.grow)}>
      {SAVED[autosave.state]}
    </span>
  );
  const close = isSheet ? (
    <Button label="Close" variant="ghost" onClick={onClose} />
  ) : (
    <IconButton
      label="Close"
      tooltip={tip('Close, keeping the draft')}
      icon={<Icon icon={X} />}
      variant="ghost"
      onClick={onClose}
    />
  );

  const writer = (
    <section
      aria-label={title}
      {...(isSheet ? { role: 'dialog', 'aria-modal': true } : {})}
      {...stylex.props(styles.sheet, isNew && styles.full, isSheet && styles.risen)}
    >
      {isSheet && (
        <header {...stylex.props(styles.sheetHeader)}>
          {close}
          <div {...stylex.props(styles.sheetTitle)}>
            <h2 {...stylex.props(styles.title)}>{title}</h2>
            {status}
          </div>
          {sendActions}
        </header>
      )}
      <div {...stylex.props(isSheet && styles.sheetBody)}>
        <div {...stylex.props(styles.fields)}>
          <div {...stylex.props(styles.row, styles.fromRow)}>
            <div {...stylex.props(styles.fromBox)}>
              <span {...stylex.props(styles.fromLabel)}>From</span>
              <label {...stylex.props(styles.from)}>
                {account && <StampDot stamp={account.stamp} />}
                <span {...stylex.props(styles.hidden)}>From</span>
                <select
                  value={writing.account}
                  onChange={(event) => {
                    const next = event.target.value;
                    const chosen = accounts.find((each) => each.id === next);
                    edit(() => ({
                      account: next,
                      signature: chosen?.signature?.trim() || undefined,
                    }));
                  }}
                  {...stylex.props(styles.select)}
                >
                  {accounts.map((each) => (
                    <option key={each.id} value={each.id}>
                      {each.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <Field
              label="To"
              value={fields.to}
              onChange={(text) => setAddresses('to', text)}
              isFocused={start.to.length === 0}
            />
            {!hasCopies && (
              <button
                type="button"
                onClick={() => setHasCopies(true)}
                {...stylex.props(styles.copies)}
              >
                Cc Bcc
              </button>
            )}
          </div>
          {hasCopies && (
            <>
              <div {...stylex.props(styles.row)}>
                <Field label="Cc" value={fields.cc} onChange={(text) => setAddresses('cc', text)} />
              </div>
              <div {...stylex.props(styles.row)}>
                <Field
                  label="Bcc"
                  value={fields.bcc}
                  onChange={(text) => setAddresses('bcc', text)}
                />
              </div>
            </>
          )}
          {isNew && (
            <div {...stylex.props(styles.row)}>
              <Field
                label="Subject"
                value={writing.subject}
                onChange={(subject) => edit(() => ({ subject }))}
              />
            </div>
          )}
        </div>

        <Editor
          start={from}
          onChange={(markdown, isEdit) => {
            if (isEdit) edit(() => ({ markdown }));
            else setWriting((was) => ({ ...was, markdown }));
          }}
          imageUrl={imageUrl}
          onFiles={(dropped) => take(dropped, true)}
          onEditor={setEditor}
          label={isNew ? 'Message' : 'Reply'}
          isFocused={start.to.length > 0}
        />
        {writing.signature && (
          <pre aria-label="Signature" {...stylex.props(styles.signature)}>
            {`-- \n${writing.signature}`}
          </pre>
        )}

        {files.length > 0 && (
          <ul aria-label="Attachments" {...stylex.props(styles.files)}>
            {files.map((attached, at) => {
              const { name, size } = 'file' in attached ? attached.file : attached;
              return (
                <li key={`${name}-${at}`} {...stylex.props(styles.file)}>
                  <span {...stylex.props(styles.fileName)}>{name}</span>
                  <span {...stylex.props(styles.fileSize)}>{sizeOf(size)}</span>
                  <IconButton
                    label={`Remove ${name}`}
                    icon={<Icon icon={X} />}
                    variant="ghost"
                    size="sm"
                    onClick={() =>
                      edit((was) => ({
                        attachments: was.attachments.filter((each) => each !== attached),
                      }))
                    }
                  />
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div
        role="toolbar"
        aria-label="Formatting and files"
        {...stylex.props(styles.toolbar, isSheet && styles.sheetToolbar)}
      >
        {editor && <Formatting editor={editor} tip={tip} />}
        <FilePicker
          id={`${id}-image`}
          label="Insert an image"
          tip={tip}
          icon={ImagePlus}
          accept="image/*"
          onFiles={(picked) => {
            for (const { contentId, file } of take(picked, true)) {
              const alt = file.name.replace(/\.[^.]+$/, '');
              editor
                ?.chain()
                .focus()
                .setImage({ src: `cid:${contentId}`, alt })
                .run();
            }
          }}
        />
        <FilePicker
          id={`${id}-file`}
          label="Attach files"
          tip={tip}
          icon={Paperclip}
          onFiles={(picked) => take(picked, false)}
        />
        {isSheet ? <span {...stylex.props(styles.grow)} /> : status}
        <IconButton
          label="Discard draft"
          tooltip={tip('Discard draft')}
          icon={<Icon icon={Trash2} />}
          variant="ghost"
          onClick={discard}
        />
        {!isSheet && close}
        {!isSheet && sendActions}
      </div>
    </section>
  );
  return isSheet ? <Over onClose={onClose}>{writer}</Over> : writer;
}

/**
 * On a phone the sheet lies over the whole app, outside the sliding panes, with the app dimmed
 * behind it. A tap on what's dimmed closes it, keeping the draft.
 */
function Over({ children, onClose }: { children: ReactNode; onClose: () => void }) {
  return createPortal(
    <>
      <div aria-hidden onClick={onClose} {...stylex.props(styles.scrim)} />
      {children}
    </>,
    document.body,
  );
}

const SAVED: Record<SaveState, string> = {
  unsaved: '',
  saving: 'Saving…',
  saved: 'Saved to Drafts',
  failed: 'Couldn’t save. Trying again…',
};

/** Bold, italic and code, each pressed while the text at the cursor has it. */
function Formatting({
  editor,
  tip,
}: {
  editor: TiptapEditor;
  tip: (label: string) => string | undefined;
}) {
  const active = useEditorState({
    editor,
    selector: ({ editor: current }) => ({
      bold: current.isActive('bold'),
      italic: current.isActive('italic'),
      code: current.isActive('code'),
    }),
  });
  const buttons: [label: string, icon: typeof Bold, key: keyof typeof active, run: () => void][] = [
    ['Bold', Bold, 'bold', () => editor.chain().focus().toggleBold().run()],
    ['Italic', Italic, 'italic', () => editor.chain().focus().toggleItalic().run()],
    ['Code', Code, 'code', () => editor.chain().focus().toggleCode().run()],
  ];
  return buttons.map(([label, icon, key, run]) => (
    <IconButton
      key={label}
      label={label}
      tooltip={tip(label)}
      icon={<Icon icon={icon} />}
      variant="ghost"
      aria-pressed={active[key]}
      onClick={run}
    />
  ));
}

/** A toolbar button that picks files. */
function FilePicker({
  id,
  label,
  tip,
  icon,
  accept,
  onFiles,
}: {
  id: string;
  label: string;
  tip: (label: string) => string | undefined;
  icon: typeof Bold;
  accept?: string;
  onFiles: (files: File[]) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <IconButton
        label={label}
        tooltip={tip(label)}
        icon={<Icon icon={icon} />}
        variant="ghost"
        onClick={() => input.current?.click()}
      />
      <input
        ref={input}
        id={id}
        type="file"
        multiple
        accept={accept}
        tabIndex={-1}
        aria-hidden
        onChange={(event) => {
          onFiles([...(event.target.files ?? [])]);
          event.target.value = '';
        }}
        {...stylex.props(styles.hidden)}
      />
    </>
  );
}

/** One line of the header: a label and what the member types beside it. */
function Field({
  label,
  value,
  onChange,
  isFocused = false,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  isFocused?: boolean;
}): ReactNode {
  return (
    <label {...stylex.props(styles.field)}>
      <span {...stylex.props(styles.label)}>{label}</span>
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        autoComplete="off"
        autoFocus={isFocused}
        spellCheck={label === 'Subject'}
        {...stylex.props(styles.input)}
      />
    </label>
  );
}

/** Where each new file shows from while it is written, for as long as the composer is open. */
function useFileUrls() {
  const urls = useRef(new Map<File, string>());
  useEffect(() => {
    const made = urls.current;
    return () => {
      for (const url of made.values()) URL.revokeObjectURL(url);
    };
  }, []);
  return (file: File) => {
    let url = urls.current.get(file);
    if (!url) {
      url = URL.createObjectURL(file);
      urls.current.set(file, url);
    }
    return url;
  };
}

function sizeOf(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function refOf({ account, path, uidValidity, uid }: MessageRef): MessageRef {
  return { account, path, uidValidity, uid };
}

/** A phone's sheet rises from the bottom of the screen. */
const rise = stylex.keyframes({
  from: { transform: 'translateY(100%)' },
  to: { transform: 'translateY(0)' },
});

const styles = stylex.create({
  sheet: {
    display: 'flex',
    flexDirection: 'column',
    gap: spacingVars['--spacing-2'],
    padding: spacingVars['--spacing-4'],
    borderRadius: tm.sheetRadius,
    backgroundColor: colorVars['--color-background-surface'],
    boxShadow: tm.sheetEdge,
    outline: {
      default: null,
      [media.forcedColors]: `${borderVars['--border-width']} solid CanvasText`,
    },
  },
  full: {
    flexGrow: 1,
  },
  // On a phone: over everything, from just below the top of the screen to its bottom edge, with
  // its header and toolbar fixed and what's written scrolling between them.
  risen: {
    position: 'fixed',
    insetInline: 0,
    bottom: 0,
    top: `calc(${tm.safeTop} + ${spacingVars['--spacing-6']})`,
    zIndex: 2,
    gap: 0,
    padding: 0,
    paddingBottom: tm.safeBottom,
    borderEndStartRadius: 0,
    borderEndEndRadius: 0,
    boxShadow: shadowVars['--shadow-high'],
    animationName: { default: rise, [media.reducedMotion]: 'none' },
    animationDuration: '300ms',
    animationTimingFunction: tm.easeLayout,
  },
  scrim: {
    position: 'fixed',
    inset: 0,
    zIndex: 2,
    backgroundColor: colorVars['--color-overlay'],
  },
  sheetHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: spacingVars['--spacing-2'],
    padding: spacingVars['--spacing-2'],
    borderBottomWidth: borderVars['--border-width'],
    borderBottomStyle: 'solid',
    borderBottomColor: colorVars['--color-border'],
  },
  sheetTitle: {
    flexGrow: 1,
    minWidth: 0,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
  },
  title: {
    margin: 0,
    fontSize: typeScaleVars['--text-body-size'],
    fontWeight: 600,
  },
  sheetBody: {
    flexGrow: 1,
    minHeight: 0,
    overflowY: 'auto',
    overscrollBehavior: 'contain',
    display: 'flex',
    flexDirection: 'column',
    gap: spacingVars['--spacing-2'],
    paddingInline: spacingVars['--spacing-4'],
  },
  sheetToolbar: {
    flexWrap: 'nowrap',
    paddingInline: spacingVars['--spacing-2'],
    borderTopWidth: borderVars['--border-width'],
    borderTopStyle: 'solid',
    borderTopColor: colorVars['--color-border'],
  },
  // On a phone the From chip has a line of its own, named as the prototype names it.
  fromRow: {
    flexWrap: { default: 'nowrap', [media.phone]: 'wrap' },
  },
  fromBox: {
    display: 'flex',
    alignItems: 'center',
    gap: spacingVars['--spacing-2'],
    flexBasis: { default: 'auto', [media.phone]: '100%' },
    minHeight: tm.target,
  },
  fromLabel: {
    display: { default: 'none', [media.phone]: 'inline' },
    color: tm.textQuiet,
    fontSize: typeScaleVars['--text-body-size'],
  },
  fields: {
    display: 'flex',
    flexDirection: 'column',
    borderBottomWidth: borderVars['--border-width'],
    borderBottomStyle: 'solid',
    borderBottomColor: colorVars['--color-border'],
  },
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: spacingVars['--spacing-2'],
    minHeight: tm.target,
  },
  from: {
    display: 'flex',
    alignItems: 'center',
    gap: spacingVars['--spacing-1'],
    paddingInline: spacingVars['--spacing-2'],
    borderRadius: radiusVars['--radius-full'],
    borderWidth: borderVars['--border-width'],
    borderStyle: 'solid',
    borderColor: colorVars['--color-border'],
  },
  select: {
    appearance: 'none',
    borderWidth: 0,
    backgroundColor: 'transparent',
    color: colorVars['--color-text-primary'],
    fontFamily: typographyVars['--font-family-body'],
    fontSize: typeScaleVars['--text-body-size'],
    fontWeight: 600,
    minHeight: tm.target,
    cursor: 'pointer',
  },
  field: {
    flexGrow: 1,
    display: 'flex',
    alignItems: 'center',
    gap: spacingVars['--spacing-2'],
    minWidth: 0,
  },
  label: {
    color: tm.textQuiet,
    fontSize: typeScaleVars['--text-body-size'],
  },
  input: {
    flexGrow: 1,
    minWidth: 0,
    minHeight: tm.target,
    padding: 0,
    borderWidth: 0,
    outline: 'none',
    backgroundColor: 'transparent',
    color: colorVars['--color-text-primary'],
    fontFamily: typographyVars['--font-family-body'],
    fontSize: typeScaleVars['--text-body-size'],
  },
  copies: {
    borderWidth: 0,
    backgroundColor: 'transparent',
    color: tm.textQuiet,
    fontFamily: typographyVars['--font-family-body'],
    fontSize: typeScaleVars['--text-supporting-size'],
    whiteSpace: 'nowrap',
    minHeight: tm.target,
    cursor: 'pointer',
  },
  signature: {
    margin: 0,
    color: tm.textQuiet,
    fontFamily: typographyVars['--font-family-body'],
    fontSize: typeScaleVars['--text-supporting-size'],
    whiteSpace: 'pre-wrap',
  },
  files: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: spacingVars['--spacing-2'],
    margin: 0,
    padding: 0,
    listStyle: 'none',
  },
  file: {
    display: 'flex',
    alignItems: 'center',
    gap: spacingVars['--spacing-2'],
    paddingInlineStart: spacingVars['--spacing-2'],
    borderRadius: radiusVars['--radius-element'],
    borderWidth: borderVars['--border-width'],
    borderStyle: 'solid',
    borderColor: colorVars['--color-border'],
    fontSize: typeScaleVars['--text-supporting-size'],
  },
  fileName: {
    maxWidth: '24ch',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  fileSize: {
    color: tm.textQuiet,
  },
  toolbar: {
    display: 'flex',
    alignItems: 'center',
    gap: spacingVars['--spacing-1'],
    flexWrap: 'wrap',
  },
  status: {
    margin: 0,
    color: tm.textQuiet,
    fontSize: typeScaleVars['--text-supporting-size'],
  },
  grow: {
    flexGrow: 1,
    textAlign: 'end',
    paddingInlineEnd: spacingVars['--spacing-2'],
  },
  hidden: {
    position: 'absolute',
    width: '1px',
    height: '1px',
    overflow: 'hidden',
    clipPath: 'inset(50%)',
    whiteSpace: 'nowrap',
  },
});
