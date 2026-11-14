import { Icon } from '@astryxdesign/core/Icon';
import { IconButton } from '@astryxdesign/core/IconButton';
import {
  borderVars,
  colorVars,
  radiusVars,
  spacingVars,
  typeScaleVars,
} from '@astryxdesign/core/theme/tokens.stylex';
import * as stylex from '@stylexjs/stylex';
import { X, type LucideIcon } from 'lucide-react';
import { useRef } from 'react';
import { tm } from '../../../app/theme/tokens.stylex.ts';
import { sizeText } from '../../../shared/size.ts';
import type { Attached } from '../core/session.ts';
import { fieldStyles } from './fieldStyles.ts';

/** A toolbar button that picks files. */
export function FilePicker({
  label,
  tip,
  icon,
  accept,
  onFiles,
}: {
  label: string;
  tip: (label: string) => string | undefined;
  icon: LucideIcon;
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
        type="file"
        multiple
        accept={accept}
        tabIndex={-1}
        aria-hidden
        onChange={(event) => {
          onFiles([...(event.target.files ?? [])]);
          event.target.value = '';
        }}
        {...stylex.props(fieldStyles.hidden)}
      />
    </>
  );
}

/**
 * The files the message carries, each with its size and a button that takes it out. An image shown
 * in the text is in the text instead.
 */
export function Attachments({
  attachments,
  onRemove,
}: {
  attachments: readonly Attached[];
  onRemove: (attached: Attached) => void;
}) {
  const files = attachments.filter((attached) => attached.contentId === undefined);
  if (files.length === 0) return null;
  return (
    <ul aria-label="Attachments" {...stylex.props(styles.files)}>
      {files.map((attached, at) => {
        const { name, size } = 'file' in attached ? attached.file : attached;
        return (
          <li key={`${name}-${at}`} {...stylex.props(styles.file)}>
            <span {...stylex.props(styles.name)}>{name}</span>
            <span {...stylex.props(styles.size)}>{sizeText(size)}</span>
            <IconButton
              label={`Remove ${name}`}
              icon={<Icon icon={X} />}
              variant="ghost"
              size="sm"
              onClick={() => onRemove(attached)}
            />
          </li>
        );
      })}
    </ul>
  );
}

const styles = stylex.create({
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
  name: {
    maxWidth: '24ch',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  size: {
    color: tm.textQuiet,
  },
});
