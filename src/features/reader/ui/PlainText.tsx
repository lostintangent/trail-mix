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
const ADDRESS = /\b(https?:\/\/[^\s<>"]+[^\s<>".,;:!?)\]'}])/i;

// Split on the address it captures, text lies at the even places and addresses at the odd ones.
const linked = (text: string) =>
  text.split(ADDRESS).map((piece, at) =>
    at % 2 === 0 ? (
      piece
    ) : (
      <a key={at} href={piece} target="_blank" rel="noopener noreferrer">
        {piece}
      </a>
    ),
  );

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
