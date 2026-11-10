import { Link } from '@astryxdesign/core/Link';
import { Spinner } from '@astryxdesign/core/Spinner';
import { spacingVars, typeScaleVars } from '@astryxdesign/core/theme/tokens.stylex';
import * as stylex from '@stylexjs/stylex';
import { tm } from '../../../app/theme/tokens.stylex.ts';

export type SearchScopeProps = {
  isFullText: boolean;
  isSearching: boolean;
  onSearchBodies: () => void;
};

/**
 * Under a search's title: what it looked through, and the way to look through message bodies too,
 * which asks the mail servers and so is slower. Editing the search looks through the index again.
 * It loads apart from the first rows, once a search begins.
 */
export function SearchScope({ isFullText, isSearching, onSearchBodies }: SearchScopeProps) {
  if (isFullText) {
    return (
      <p role="status" {...stylex.props(styles.scope)}>
        {isSearching && <Spinner size="sm" />}
        {isSearching
          ? 'Searching message bodies on your mail servers…'
          : 'Matches in message bodies too.'}
      </p>
    );
  }
  return (
    <p {...stylex.props(styles.scope)}>
      <span>
        Matches in people, subjects and previews.{' '}
        <Link type="supporting" onClick={onSearchBodies}>
          Search message bodies too
        </Link>
        , which is slower.
      </span>
    </p>
  );
}

const styles = stylex.create({
  scope: {
    display: 'flex',
    alignItems: 'center',
    gap: spacingVars['--spacing-2'],
    margin: 0,
    color: tm.textQuiet,
    fontSize: typeScaleVars['--text-supporting-size'],
  },
});
