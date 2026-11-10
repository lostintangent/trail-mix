import { Icon } from '@astryxdesign/core/Icon';
import { IconButton } from '@astryxdesign/core/IconButton';
import {
  borderVars,
  colorVars,
  durationVars,
  easeVars,
  radiusVars,
  spacingVars,
  typeScaleVars,
  typographyVars,
} from '@astryxdesign/core/theme/tokens.stylex';
import * as stylex from '@stylexjs/stylex';
import { Search, X } from 'lucide-react';
import { createContext, use, useEffect, useRef, useState } from 'react';
import { media, tm } from '../../../app/theme/tokens.stylex.ts';
import { highlight, type Marks } from '../../mail/core/index.ts';
import type { SearchScopeProps } from './SearchScope.tsx';

/** What the search field shows, and where what the member types goes. */
export type SearchState = { text: string; onSearch: (text: string) => void };

/**
 * The search the field shows. The field reads it from here rather than from props, so whatever
 * holds the field, the sidebar on a desktop or the list on a phone, doesn't redraw as the member
 * types.
 */
export const SearchContext = createContext<SearchState>({ text: '', onSearch: () => {} });

/**
 * The field that searches every account as the member types. It is on screen from the first paint,
 * so it is a native search input drawn with Astryx's input tokens, not Astryx's TextInput, whose
 * field machinery would weigh on the first load.
 */
export function SearchField() {
  const { text, onSearch } = use(SearchContext);
  const input = useRef<HTMLInputElement>(null);
  return (
    <label {...stylex.props(styles.field)}>
      <Icon icon={Search} size="sm" color="secondary" />
      <input
        ref={input}
        type="search"
        aria-label="Search mail"
        placeholder="Search mail"
        value={text}
        onChange={(event) => onSearch(event.target.value)}
        onFocus={() => void loadScope().catch(() => {})}
        enterKeyHint="search"
        autoComplete="off"
        spellCheck={false}
        {...stylex.props(styles.input)}
      />
      {text && (
        <IconButton
          label="Clear search"
          icon={<Icon icon={X} />}
          variant="ghost"
          size="sm"
          onClick={() => {
            onSearch('');
            input.current?.focus();
          }}
        />
      )}
    </label>
  );
}

type ScopeModule = typeof import('./SearchScope.tsx');
let scopeModule: ScopeModule | undefined;
const loadScope = async () => (scopeModule ??= await import('./SearchScope.tsx'));

/** What a search looked through, once its line has loaded. The field asks for it on focus. */
export function SearchScope(props: SearchScopeProps) {
  const [module, setModule] = useState(scopeModule);
  useEffect(() => {
    if (!module) void loadScope().then(setModule, () => {});
  }, [module]);
  return module ? <module.SearchScope {...props} /> : null;
}

/** Text with what a search matched marked with the highlighter. */
export function Marked({ text, marks }: { text: string; marks: Marks }) {
  if (marks.length === 0) return text;
  return (
    <>
      {highlight(text, marks).map(({ text, isMarked }, at) =>
        isMarked ? (
          <mark key={at} {...stylex.props(styles.mark)}>
            {text}
          </mark>
        ) : (
          text
        ),
      )}
    </>
  );
}

const styles = stylex.create({
  // As Astryx draws an input: an emphasized edge that turns accent with a muted ring on focus.
  field: {
    boxSizing: 'border-box',
    display: 'flex',
    alignItems: 'center',
    gap: spacingVars['--spacing-2'],
    minHeight: tm.target,
    paddingInline: spacingVars['--spacing-2'],
    borderWidth: borderVars['--border-width'],
    borderStyle: 'solid',
    borderColor: {
      default: colorVars['--color-border-emphasized'],
      ':focus-within': { default: colorVars['--color-accent'], [media.forcedColors]: 'Highlight' },
    },
    borderRadius: radiusVars['--radius-element'],
    backgroundColor: colorVars['--color-background-surface'],
    boxShadow: {
      default: 'none',
      ':focus-within': `inset 0 0 0 2px ${colorVars['--color-accent-muted']}`,
    },
    transitionProperty: 'border-color, box-shadow',
    transitionDuration: {
      default: durationVars['--duration-fast'],
      [media.reducedMotion]: '0s',
    },
    transitionTimingFunction: easeVars['--ease-standard'],
    cursor: 'text',
  },
  input: {
    flexGrow: 1,
    minWidth: 0,
    padding: 0,
    borderWidth: 0,
    outline: 'none',
    backgroundColor: 'transparent',
    color: colorVars['--color-text-primary'],
    fontFamily: typographyVars['--font-family-body'],
    // A phone zooms into a field whose text is smaller than 16px, so the body size holds there.
    fontSize: typeScaleVars['--text-body-size'],
    appearance: 'none',
    '::placeholder': { color: colorVars['--color-text-secondary'] },
    // The clear button is the field's own, the same in every browser.
    '::-webkit-search-cancel-button': { appearance: 'none' },
  },
  mark: {
    backgroundColor: { default: tm.highlight, [media.forcedColors]: 'Mark' },
    color: { default: tm.onHighlight, [media.forcedColors]: 'MarkText' },
    borderRadius: radiusVars['--radius-inner'],
    boxShadow: `0 0 0 1px ${tm.highlight}`,
  },
});
