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
import { Placeholder } from '@tiptap/extensions';
import { Markdown } from '@tiptap/markdown';
import { EditorContent, useEditor, type Editor as TiptapEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { useEffect, useRef } from 'react';
import { tm } from '../../../app/theme/tokens.stylex.ts';

/**
 * Where the member writes: Markdown, edited as the text it makes. Typing Markdown formats it as it
 * goes, the toolbar does the same, and what the composer saves is the Markdown the editor holds.
 *
 * An image shows only from the draft itself, by its `cid:`, or as a `data:` image. A draft opened
 * from another client is foreign content in Trail Mix's own page, so the editor never loads a
 * remote image from it.
 */
export type EditorProps = {
  markdown: string;
  onChange: (markdown: string) => void;
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
  markdown,
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
  const editor = useEditor({
    autofocus: isFocused ? 'end' : false,
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
      DraftImage.configure({ imageUrl: (id) => latest.current.imageUrl(id) }),
      Placeholder.configure({
        placeholder: 'Write in Markdown, or use the toolbar',
        emptyEditorClass: css(styles.placeholder),
      }),
    ],
    content: markdown,
    contentType: 'markdown',
    editorProps: {
      attributes: {
        'aria-label': label,
        'aria-multiline': 'true',
        role: 'textbox',
        class: css(styles.prose),
      },
      handlePaste: (_view, event) => place(event.clipboardData?.files),
      handleDrop: (_view, event) => place(event.dataTransfer?.files),
    },
    onUpdate: ({ editor: updated }) => latest.current.onChange(updated.getMarkdown()),
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

  return <EditorContent editor={editor} {...stylex.props(styles.editor)} />;
}

/** An image node that shows only what the draft holds, as `imageUrl` resolves it. */
const DraftImage = Image.extend<{ imageUrl: (contentId: string) => string | undefined }>({
  addOptions() {
    return { ...this.parent?.(), imageUrl: () => undefined };
  },
  addNodeView() {
    return ({ node }) => {
      const image = document.createElement('img');
      image.className = css(styles.image);
      const show = (src: string, alt: string) => {
        const contentId = /^cid:(.+)$/i.exec(src)?.[1];
        const url = contentId
          ? this.options.imageUrl(contentId)
          : /^data:image\//i.test(src)
            ? src
            : undefined;
        if (url) image.src = url;
        else image.removeAttribute('src');
        image.alt = alt;
      };
      show(String(node.attrs['src'] ?? ''), String(node.attrs['alt'] ?? ''));
      return {
        dom: image,
        update: (updated) => {
          if (updated.type !== node.type) return false;
          show(String(updated.attrs['src'] ?? ''), String(updated.attrs['alt'] ?? ''));
          return true;
        },
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
