import { Link } from '@astryxdesign/core/Link';
import { Spinner } from '@astryxdesign/core/Spinner';
import { spacingVars, typeScaleVars } from '@astryxdesign/core/theme/tokens.stylex';
import * as stylex from '@stylexjs/stylex';
import { media, tm } from '../../../app/theme/tokens.stylex.ts';
import { MATCHES_LISTED } from '../../mailroom/client/index.ts';

export type SearchScopeProps = {
  isFullText: boolean;
  isSearching: boolean;
  /** Whether more conversations match than a search lists, so it lists only the newest. */
  isLimited: boolean;
  onSearchBodies: () => void;
};

/**
 * Under a search's title: what it looked through, and the way to look through message bodies too,
 * which asks the mail servers and so is slower. Editing the search looks through the index again.
 * A search that matches more than it lists says it lists the newest. It loads apart from the first
 * rows, once a search begins.
 */
export function SearchScope({
  isFullText,
  isSearching,
  isLimited,
  onSearchBodies,
}: SearchScopeProps) {
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
        {isLimited ? `The newest ${MATCHES_LISTED.toLocaleString('en')} matches` : 'Matches'} in
        people, subjects and previews.{' '}
        <Link type="supporting" onClick={onSearchBodies} xstyle={styles.bodies}>
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
  // A finger's target that takes no room in its line, so the sentence lies as it did.
  bodies: {
    minHeight: { default: null, [media.coarse]: tm.target },
    marginBlock: { default: null, [media.coarse]: `calc(${tm.target} / -2)` },
  },
});
