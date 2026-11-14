import { Dialog, DialogHeader } from '@astryxdesign/core/Dialog';
import {
  colorVars,
  radiusVars,
  spacingVars,
  typeScaleVars,
  typographyVars,
} from '@astryxdesign/core/theme/tokens.stylex';
import * as stylex from '@stylexjs/stylex';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { tm } from '../../../app/theme/tokens.stylex.ts';
import type { Message } from '../../mail/core/index.ts';
import { bodyQuery, messageUrl } from '../../mailroom/client/index.ts';
import { refOf } from './refs.ts';

/** The most of a message's source shown here. The whole of it stays a download away. */
const SHOWN = 512 * 1024;

type SourceDialogProps = { message: Message; onClose: () => void };

/**
 * A message's headers and raw source, as text. Both come from the message as received, and React
 * writes them as text, so nothing in them is ever read as markup.
 */
export function SourceDialog({ message, onClose }: SourceDialogProps) {
  const ref = refOf(message);
  const headers = useQuery(bodyQuery(ref)).data?.headers ?? [];
  const url = messageUrl(ref);
  const source = useSource(url);
  return (
    <Dialog
      isOpen
      onOpenChange={(open) => !open && onClose()}
      purpose="info"
      width="min(960px, 100%)"
      maxHeight="90vh"
    >
      <DialogHeader title="Source" subtitle={message.subject} onOpenChange={() => onClose()} />
      <div {...stylex.props(styles.body)}>
        <dl {...stylex.props(styles.headers)}>
          {headers.map(([name, value], i) => (
            <div key={i} {...stylex.props(styles.header)}>
              <dt {...stylex.props(styles.headerName)}>{name}</dt>
              <dd {...stylex.props(styles.headerValue)}>{value}</dd>
            </div>
          ))}
        </dl>
        <pre aria-label="Raw source" {...stylex.props(styles.source)}>
          {source.state === 'loading'
            ? 'Loading the source…'
            : source.state === 'failed'
              ? 'The source could not be loaded.'
              : source.text}
        </pre>
        {source.state === 'loaded' && source.truncated && (
          <a href={url} download="message.eml" {...stylex.props(styles.download)}>
            Download the whole source
          </a>
        )}
      </div>
    </Dialog>
  );
}

type Source =
  | { state: 'loading' }
  | { state: 'failed' }
  | { state: 'loaded'; text: string; truncated: boolean };

function useSource(url: string): Source {
  const [source, setSource] = useState<Source>({ state: 'loading' });
  useEffect(() => {
    const abort = new AbortController();
    fetch(url, { signal: abort.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`${response.status}`);
        const text = await response.text();
        setSource({ state: 'loaded', text: text.slice(0, SHOWN), truncated: text.length > SHOWN });
      })
      .catch(() => {
        if (!abort.signal.aborted) setSource({ state: 'failed' });
      });
    return () => abort.abort();
  }, [url]);
  return source;
}

const styles = stylex.create({
  body: {
    display: 'flex',
    flexDirection: 'column',
    gap: spacingVars['--spacing-3'],
    minHeight: 0,
    overflow: 'auto',
  },
  headers: {
    display: 'grid',
    gridTemplateColumns: 'max-content 1fr',
    columnGap: spacingVars['--spacing-3'],
    rowGap: spacingVars['--spacing-0-5'],
    margin: 0,
    fontSize: typeScaleVars['--text-supporting-size'],
  },
  header: {
    display: 'contents',
  },
  headerName: {
    color: tm.textQuiet,
    fontWeight: 600,
  },
  headerValue: {
    margin: 0,
    overflowWrap: 'anywhere',
    fontFamily: typographyVars['--font-family-code'],
  },
  source: {
    margin: 0,
    padding: spacingVars['--spacing-3'],
    borderRadius: radiusVars['--radius-element'],
    backgroundColor: colorVars['--color-background-muted'],
    whiteSpace: 'pre-wrap',
    overflowWrap: 'anywhere',
    fontFamily: typographyVars['--font-family-code'],
    fontSize: typeScaleVars['--text-supporting-size'],
  },
  download: {
    alignSelf: 'flex-start',
    color: colorVars['--color-text-accent'],
  },
});
