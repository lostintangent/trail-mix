import {
  borderVars,
  colorVars,
  radiusVars,
  spacingVars,
  typeScaleVars,
  typographyVars,
} from '@astryxdesign/core/theme/tokens.stylex';
import * as stylex from '@stylexjs/stylex';
import Image from '@tiptap/extension-image';
import { Selection } from '@tiptap/pm/state';
import { Placeholder } from '@tiptap/extensions';
import { Markdown } from '@tiptap/markdown';
import { EditorContent, useEditor, type Editor as TiptapEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { useEffect, useRef } from 'react';
import { tm } from '../../../app/theme/tokens.stylex.ts';
import { editableHtml } from './editable.ts';

/**
 * Where the member writes: Markdown, edited as the text it makes. Typing Markdown formats it as it
 * goes, the toolbar does the same, and what the composer saves is the Markdown the editor holds.
 *
 * An image shows only from the draft itself, by its `cid:`, or as a `data:` image. A draft opened
 * from another client is foreign content in Trail Mix's own page, so the editor never loads a
 * remote image from it.
 */
export type EditorProps = {
  /**
   * What the editor starts with: Markdown, or the HTML of a draft another client wrote, which it
   * turns into Markdown and hands to `onChange` once, as what was there rather than a change.
   */
  start: { markdown: string } | { html: string };
  onChange: (markdown: string, isEdit: boolean) => void;
  /** Where an image the draft holds shows from, by its Content-ID, while it is written. */
  imageUrl: (contentId: string) => string | undefined;
  /** Takes pasted or dropped files, and says which are images to place where they landed. */
  onFiles: (files: File[]) => { contentId: string; file: File }[];
  /** The editor, once it exists, for the toolbar. */
  onEditor: (editor: TiptapEditor) => void;
  label: string;
  /** Whether the cursor starts in the text, as in a reply, where the recipients are already set. */
  isFocused?: boolean;
};

export function Editor({
  start,
  onChange,
  imageUrl,
  onFiles,
  onEditor,
  label,
  isFocused = false,
}: EditorProps) {
  const latest = useRef({ onChange, imageUrl, onFiles });
  useEffect(() => {
    latest.current = { onChange, imageUrl, onFiles };
  });
  const known = useRef<string>(undefined);
  // Every image's way to look up where it shows from again, since that changes as the composer
  // takes a pasted file and as a save moves it into the draft.
  const images = useRef(new Set<() => void>());
  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3], HTMLAttributes: { class: css(styles.heading) } },
        paragraph: { HTMLAttributes: { class: css(styles.block) } },
        bulletList: { HTMLAttributes: { class: css(styles.block, styles.list, styles.bullets) } },
        orderedList: { HTMLAttributes: { class: css(styles.block, styles.list, styles.numbers) } },
        blockquote: { HTMLAttributes: { class: css(styles.block, styles.quote) } },
        code: { HTMLAttributes: { class: css(styles.code) } },
        codeBlock: { HTMLAttributes: { class: css(styles.block, styles.codeBlock) } },
        link: {
          openOnClick: false,
          autolink: true,
          HTMLAttributes: { class: css(styles.link), rel: 'noopener noreferrer' },
        },
      }),
      Markdown,
      DraftImage.configure({
        imageUrl: (id) => latest.current.imageUrl(id),
        shown: images.current,
      }),
      Placeholder.configure({
        placeholder: 'Write in Markdown, or use the toolbar',
        emptyEditorClass: css(styles.placeholder),
      }),
    ],
    ...('html' in start
      ? { content: editableHtml(start.html), contentType: 'html' as const }
      : { content: start.markdown, contentType: 'markdown' as const }),
    onCreate: ({ editor: created }) => {
      known.current = created.getMarkdown();
      if ('html' in start) latest.current.onChange(known.current, false);
      if (isFocused) focusAtEnd(created);
    },
    editorProps: {
      attributes: {
        'aria-label': label,
        'aria-multiline': 'true',
        role: 'textbox',
        class: css(styles.prose),
      },
      // ⌘↵ is the registry's Send and Esc its Back, which closes the composer, so the editor leaves
      // both alone rather than breaking the line or swallowing Esc.
      handleDOMEvents: {
        keydown: (_view, event) =>
          event.key === 'Escape' || (event.key === 'Enter' && (event.metaKey || event.ctrlKey)),
      },
      handlePaste: (_view, event) => place(event.clipboardData?.files),
      handleDrop: (_view, event) => place(event.dataTransfer?.files),
    },
    // The editor changes its own document too, as it starts and when it adds a line to type on
    // after a list at the end. Only a change to what the Markdown says, once it has started, is the
    // member's.
    onUpdate: ({ editor: updated }) => {
      const markdown = updated.getMarkdown();
      const isEdit = known.current !== undefined && markdown.trimEnd() !== known.current.trimEnd();
      known.current = markdown;
      latest.current.onChange(markdown, isEdit);
    },
  });
  const current = useRef(editor);
  useEffect(() => {
    current.current = editor;
  }, [editor]);

  /** Hands pasted or dropped files to the composer, and places its images where the cursor is. */
  function place(list: FileList | null | undefined): boolean {
    const files = [...(list ?? [])];
    const writing = current.current;
    if (!writing || files.length === 0) return false;
    for (const { contentId, file } of latest.current.onFiles(files)) {
      const alt = file.name.replace(/\.[^.]+$/, '');
      writing
        .chain()
        .focus()
        .setImage({ src: `cid:${contentId}`, alt })
        .run();
    }
    return true;
  }

  useEffect(() => {
    if (editor) onEditor(editor);
  }, [editor, onEditor]);
  // A file the composer took shows once the composer has it, and a saved one from its draft.
  useEffect(() => {
    for (const show of images.current) show();
  });

  return <EditorContent editor={editor} {...stylex.props(styles.editor)} />;
}

/**
 * Puts the cursor at the end of the text. Tiptap's own `focus` builds its transaction before it
 * focuses the page on a phone, which applies one of its own first, so its transaction no longer
 * fits. The cursor moves first here, then the page focuses.
 */
function focusAtEnd(editor: TiptapEditor) {
  editor.view.dispatch(editor.state.tr.setSelection(Selection.atEnd(editor.state.doc)));
  editor.view.focus();
  editor.commands.scrollIntoView();
}

/**
 * An image node that shows only what the draft holds, as `imageUrl` resolves it. Its `src` stays
 * the `cid:` the Markdown saves, and only the page's `<img>` loads from where `imageUrl` says.
 */
const DraftImage = Image.extend<{
  imageUrl: (contentId: string) => string | undefined;
  /** Each image's way to look its source up again, while it is in the editor. */
  shown: Set<() => void>;
}>({
  addOptions() {
    return { ...this.parent?.(), imageUrl: () => undefined, shown: new Set() };
  },
  addNodeView() {
    return ({ node }) => {
      const image = document.createElement('img');
      image.className = css(styles.image);
      let current = node;
      const show = () => {
        const src = String(current.attrs['src'] ?? '');
        const contentId = /^cid:(.+)$/i.exec(src)?.[1];
        const url = contentId
          ? this.options.imageUrl(contentId)
          : /^data:image\//i.test(src)
            ? src
            : undefined;
        if (!url) image.removeAttribute('src');
        else if (image.getAttribute('src') !== url) image.src = url;
        image.alt = String(current.attrs['alt'] ?? '');
      };
      show();
      this.options.shown.add(show);
      return {
        dom: image,
        update: (updated) => {
          if (updated.type !== current.type) return false;
          current = updated;
          show();
          return true;
        },
        destroy: () => this.options.shown.delete(show),
      };
    };
  },
});

/** StyleX classes for nodes the editor draws itself. */
function css(...styles: stylex.StyleXStyles[]): string {
  return stylex.props(...styles).className ?? '';
}

const styles = stylex.create({
  editor: {
    flexGrow: 1,
    minHeight: 0,
    overflowY: 'auto',
  },
  prose: {
    minHeight: '6lh',
    maxWidth: tm.measure,
    paddingBlock: spacingVars['--spacing-2'],
    outline: 'none',
    color: colorVars['--color-text-primary'],
    fontFamily: typographyVars['--font-family-body'],
    fontSize: typeScaleVars['--text-body-size'],
    lineHeight: typeScaleVars['--text-body-leading'],
    overflowWrap: 'break-word',
  },
  block: {
    marginBlock: 0,
    marginBlockEnd: spacingVars['--spacing-2'],
  },
  heading: {
    marginBlock: spacingVars['--spacing-2'],
    fontSize: typeScaleVars['--text-heading-3-size'],
    lineHeight: typeScaleVars['--text-heading-3-leading'],
  },
  list: {
    paddingInlineStart: spacingVars['--spacing-5'],
  },
  bullets: {
    listStyleType: 'disc',
  },
  numbers: {
    listStyleType: 'decimal',
  },
  quote: {
    marginInline: 0,
    paddingInlineStart: spacingVars['--spacing-3'],
    borderInlineStartWidth: `calc(${borderVars['--border-width']} * 3)`,
    borderInlineStartStyle: 'solid',
    borderInlineStartColor: colorVars['--color-border'],
    color: colorVars['--color-text-secondary'],
  },
  code: {
    fontFamily: typographyVars['--font-family-code'],
    fontSize: typeScaleVars['--text-code-size'],
    paddingInline: spacingVars['--spacing-0-5'],
    borderRadius: radiusVars['--radius-inner'],
    backgroundColor: colorVars['--color-background-muted'],
  },
  codeBlock: {
    padding: spacingVars['--spacing-2'],
    borderRadius: radiusVars['--radius-inner'],
    backgroundColor: colorVars['--color-background-muted'],
    fontFamily: typographyVars['--font-family-code'],
    fontSize: typeScaleVars['--text-code-size'],
    overflowX: 'auto',
  },
  link: {
    color: colorVars['--color-text-accent'],
  },
  image: {
    display: 'block',
    maxWidth: '100%',
    height: 'auto',
    borderRadius: radiusVars['--radius-inner'],
  },
  placeholder: {
    '::before': {
      content: 'attr(data-placeholder)',
      float: 'left',
      height: 0,
      color: tm.textQuiet,
      pointerEvents: 'none',
    },
  },
});
