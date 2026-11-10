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
} from '@astryxdesign/core/theme/tokens.stylex';
import * as stylex from '@stylexjs/stylex';
import { useQuery } from '@tanstack/react-query';
import { useEditorState, type Editor as TiptapEditor } from '@tiptap/react';
import {
  Bold,
  Code,
  ImagePlus,
  Italic,
  Paperclip,
  Send as SendIcon,
  Trash2,
  X,
} from 'lucide-react';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { StampDot } from '../../../app/theme/StampDot.tsx';
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

/** What the member asked to write: a new message, a reply, or a draft opened again. */
export type Compose =
  | { as: 'new'; account: Account }
  | { as: 'reply'; to: Message; all: boolean }
  | { as: 'draft'; draft: Message; conversation: readonly Message[] };

export type ComposerProps = {
  compose: Compose;
  accounts: readonly Account[];
  /**
   * Each draft a save makes, and the one it replaced, so the reader can leave the draft being
   * written out of the conversation it shows.
   */
  onDraft?: (saved: MessageRef, replaced: MessageRef | undefined) => void;
  /** Sends the draft once everything written is saved. Without it the composer only saves. */
  onSend?: (draft: MessageRef) => void;
  /** Closes the composer, which saves what is still unsaved as it goes. */
  onClose: () => void;
};

/**
 * Where the member writes a message, on a sheet of its own: under the conversation for a reply, and
 * filling the reader for a new message. It starts once what it needs has loaded: the parent's
 * headers for a reply, or the draft's words and files.
 */
export function Composer({ compose, accounts, onDraft, onSend, onClose }: ComposerProps) {
  const ref =
    compose.as === 'reply' ? compose.to : compose.as === 'draft' ? compose.draft : undefined;
  const { data: body, isError } = useQuery({
    ...bodyQuery(ref ?? NO_REF),
    enabled: ref !== undefined,
  });
  const start = startOf(compose, accounts, body);
  if (!start) {
    return (
      <section aria-label="Message" aria-busy={!isError} {...stylex.props(styles.sheet)}>
        <p {...stylex.props(styles.status)}>
          {isError ? 'This message couldn’t be loaded to write from.' : 'Opening…'}
        </p>
      </section>
    );
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
      isNew={compose.as === 'new' || !start.inReplyTo}
      accounts={accounts}
      onDraft={onDraft}
      onSend={onSend}
      onClose={onClose}
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
  onClose,
}: {
  start: Writing;
  from: EditorProps['start'];
  draft: MessageRef | undefined;
  isNew: boolean;
  accounts: readonly Account[];
} & Pick<ComposerProps, 'onDraft' | 'onSend' | 'onClose'>) {
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
  const [isSending, setSending] = useState(false);
  const send =
    onSend &&
    (async () => {
      if (isSending) return;
      setSending(true);
      try {
        const saved = await autosave.settle();
        if (saved) {
          onSend(saved);
          onClose();
        }
      } catch {
        // The status says the save failed, and the save is tried again.
      } finally {
        setSending(false);
      }
    });
  const discard = () => {
    void autosave.discard();
    onClose();
  };
  const account = accounts.find((each) => each.id === writing.account);
  const files = writing.attachments.filter((attached) => attached.contentId === undefined);

  return (
    <section
      aria-label={isNew ? 'New message' : 'Reply'}
      {...stylex.props(styles.sheet, isNew && styles.full)}
    >
      <div {...stylex.props(styles.fields)}>
        <div {...stylex.props(styles.row)}>
          <label {...stylex.props(styles.from)}>
            {account && <StampDot stamp={account.stamp} />}
            <span {...stylex.props(styles.hidden)}>From</span>
            <select
              value={writing.account}
              onChange={(event) => {
                const next = event.target.value;
                const chosen = accounts.find((each) => each.id === next);
                edit(() => ({ account: next, signature: chosen?.signature?.trim() || undefined }));
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

      <div role="toolbar" aria-label="Formatting and files" {...stylex.props(styles.toolbar)}>
        {editor && <Formatting editor={editor} />}
        <FilePicker
          id={`${id}-image`}
          label="Insert an image"
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
          icon={Paperclip}
          onFiles={(picked) => take(picked, false)}
        />
        <span role="status" {...stylex.props(styles.status, styles.grow)}>
          {SAVED[autosave.state]}
        </span>
        <IconButton
          label="Discard draft"
          tooltip="Discard draft"
          icon={<Icon icon={Trash2} />}
          variant="ghost"
          onClick={discard}
        />
        <IconButton
          label="Close"
          tooltip="Close, keeping the draft"
          icon={<Icon icon={X} />}
          variant="ghost"
          onClick={onClose}
        />
        {send && (
          <Button
            label="Send"
            variant="primary"
            icon={<Icon icon={SendIcon} />}
            isDisabled={
              isSending || writing.to.length + writing.cc.length + writing.bcc.length === 0
            }
            onClick={() => void send()}
          />
        )}
      </div>
    </section>
  );
}

const SAVED: Record<SaveState, string> = {
  unsaved: '',
  saving: 'Saving…',
  saved: 'Saved to Drafts',
  failed: 'Couldn’t save. Trying again…',
};

/** Bold, italic and code, each pressed while the text at the cursor has it. */
function Formatting({ editor }: { editor: TiptapEditor }) {
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
      tooltip={label}
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
  icon,
  accept,
  onFiles,
}: {
  id: string;
  label: string;
  icon: typeof Bold;
  accept?: string;
  onFiles: (files: File[]) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <IconButton
        label={label}
        tooltip={label}
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
