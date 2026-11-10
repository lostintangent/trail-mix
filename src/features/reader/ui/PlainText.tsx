import { spacingVars, typographyVars, typeScaleVars } from '@astryxdesign/core/theme/tokens.stylex';
import * as stylex from '@stylexjs/stylex';
import { tm } from '../../../app/theme/tokens.stylex.ts';

/**
 * Plain-text mail, set in monospace as it was written, with its web addresses as links. React
 * writes it as text, so nothing in it is ever read as markup.
 */
export function PlainText({ text }: { text: string }) {
  return <div {...stylex.props(styles.text)}>{linked(text)}</div>;
}

/** Web addresses, without the punctuation that usually ends the sentence around them. */
const ADDRESS = /\bhttps?:\/\/[^\s<>"]+[^\s<>".,;:!?)\]'}]/gi;

function linked(text: string) {
  const pieces: (string | React.JSX.Element)[] = [];
  let at = 0;
  for (const match of text.matchAll(ADDRESS)) {
    const href = match[0];
    pieces.push(text.slice(at, match.index));
    pieces.push(
      <a key={match.index} href={href} target="_blank" rel="noopener noreferrer">
        {href}
      </a>,
    );
    at = match.index + href.length;
  }
  pieces.push(text.slice(at));
  return pieces;
}

const styles = stylex.create({
  text: {
    maxWidth: tm.measure,
    margin: 0,
    paddingBlock: spacingVars['--spacing-1'],
    whiteSpace: 'pre-wrap',
    overflowWrap: 'anywhere',
    fontFamily: typographyVars['--font-family-code'],
    fontSize: typeScaleVars['--text-code-size'],
    lineHeight: typeScaleVars['--text-code-leading'],
  },
});
