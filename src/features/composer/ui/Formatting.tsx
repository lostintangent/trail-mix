import { Button } from '@astryxdesign/core/Button';
import { Icon } from '@astryxdesign/core/Icon';
import { IconButton } from '@astryxdesign/core/IconButton';
import {
  borderVars,
  colorVars,
  radiusVars,
  spacingVars,
} from '@astryxdesign/core/theme/tokens.stylex';
import * as stylex from '@stylexjs/stylex';
import { useEditorState, type Editor as TiptapEditor } from '@tiptap/react';
import { Bold, Code, Italic, Link as LinkIcon, X } from 'lucide-react';
import { useState } from 'react';
import { linkOf } from '../core/links.ts';
import { fieldStyles } from './fieldStyles.ts';

/** Where in the text a link applies, from one position to another. */
export type LinkRange = { from: number; to: number };

/**
 * Bold, italic, code and a link, each pressed while the text at the cursor has it. Link asks for
 * an address for the selection as it was pressed, or takes the link away from text that has one.
 */
export function Formatting({
  editor,
  tip,
  onLink,
}: {
  editor: TiptapEditor;
  tip: (label: string) => string | undefined;
  onLink: (range: LinkRange) => void;
}) {
  const active = useEditorState({
    editor,
    selector: ({ editor: current }) => ({
      bold: current.isActive('bold'),
      italic: current.isActive('italic'),
      code: current.isActive('code'),
      link: current.isActive('link'),
    }),
  });
  const link = () => {
    if (active.link) {
      editor.chain().focus().extendMarkRange('link').unsetLink().run();
    } else {
      const { from, to } = editor.state.selection;
      onLink({ from, to });
    }
  };
  const buttons: [label: string, icon: typeof Bold, key: keyof typeof active, run: () => void][] = [
    ['Bold', Bold, 'bold', () => editor.chain().focus().toggleBold().run()],
    ['Italic', Italic, 'italic', () => editor.chain().focus().toggleItalic().run()],
    ['Code', Code, 'code', () => editor.chain().focus().toggleCode().run()],
    ['Link', LinkIcon, 'link', link],
  ];
  // Pressing one leaves the focus, and so the selection it acts on, in the text.
  return (
    <span onMouseDown={(event) => event.preventDefault()} {...stylex.props(styles.contents)}>
      {buttons.map(([label, icon, key, run]) => (
        <IconButton
          key={label}
          label={label}
          tooltip={tip(label)}
          icon={<Icon icon={icon} />}
          variant="ghost"
          aria-pressed={active[key]}
          onClick={run}
        />
      ))}
    </span>
  );
}

/**
 * Where the member gives a link's address: for the selected text, or, with nothing selected, as
 * a link of its own where the cursor is. Enter adds it and Esc goes back to the text.
 */
export function LinkField({
  editor,
  range,
  onDone,
}: {
  editor: TiptapEditor;
  /** The selection as Link was pressed. Focus moving into the field can lose the live one. */
  range: LinkRange;
  onDone: () => void;
}) {
  const [typed, setTyped] = useState('');
  const href = linkOf(typed);
  const done = () => {
    onDone();
    editor.commands.focus();
  };
  return (
    <form
      aria-label="Link"
      onSubmit={(event) => {
        event.preventDefault();
        if (!href) return;
        const chain = editor.chain().focus().setTextSelection(range);
        if (range.from === range.to) {
          chain
            .insertContent({
              type: 'text',
              text: typed.trim(),
              marks: [{ type: 'link', attrs: { href } }],
            })
            .run();
        } else {
          chain.extendMarkRange('link').setLink({ href }).run();
        }
        onDone();
      }}
      {...stylex.props(styles.linkField)}
    >
      <input
        aria-label="Link address"
        placeholder="Paste or type a link"
        inputMode="url"
        autoComplete="off"
        spellCheck={false}
        autoFocus
        value={typed}
        onChange={(event) => setTyped(event.target.value)}
        onKeyDown={(event) => {
          // Esc leaves the link unmade, and doesn't close the composer as Back.
          if (event.key !== 'Escape') return;
          event.preventDefault();
          done();
        }}
        {...stylex.props(fieldStyles.input)}
      />
      <Button label="Add link" type="submit" variant="secondary" size="sm" isDisabled={!href} />
      <IconButton
        label="Cancel"
        icon={<Icon icon={X} />}
        variant="ghost"
        size="sm"
        onClick={done}
      />
    </form>
  );
}

const styles = stylex.create({
  contents: {
    display: 'contents',
  },
  linkField: {
    display: 'flex',
    alignItems: 'center',
    gap: spacingVars['--spacing-2'],
    paddingInline: spacingVars['--spacing-2'],
    borderRadius: radiusVars['--radius-element'],
    borderWidth: borderVars['--border-width'],
    borderStyle: 'solid',
    borderColor: colorVars['--color-border'],
  },
});
