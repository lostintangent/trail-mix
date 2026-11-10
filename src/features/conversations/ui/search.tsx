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
import { createContext, Suspense, use, useEffect, useId, useRef, useState } from 'react';
import { media, tm } from '../../../app/theme/tokens.stylex.ts';
import {
  bestCommandFor,
  CommandMatches,
  isApple,
  preloadCommandMatches,
  registerSearchFocus,
  shortcutLabel,
  type PaletteKeys,
} from '../../commands/index.ts';
import { useMediaQuery } from '../../../shared/useMediaQuery.ts';
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
  // On a desktop the field is the way to the commands too, and says so, with its key.
  const isPhone = useMediaQuery(media.phone);
  // The commands show while the member works in the field: at once when ⌘K opened it, and
  // otherwise for whatever typed text names one.
  const [commands, setCommands] = useState<'closed' | 'typed' | 'all'>('closed');
  useEffect(
    () =>
      registerSearchFocus(() => {
        input.current?.focus();
        input.current?.select();
        setCommands('all');
      }),
    [],
  );
  const done = () => {
    setCommands('closed');
    onSearch('');
    input.current?.blur();
  };
  const isOpen = commands === 'all' || (commands === 'typed' && text.trim() !== '');
  const keys = useRef<PaletteKeys['current']>(undefined);
  const listId = useId();
  const [active, setActive] = useState<string>();

  return (
    <div
      {...stylex.props(styles.palette)}
      onFocus={() => setCommands((was) => (was === 'closed' ? 'typed' : was))}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setCommands('closed');
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && isOpen) {
          // The field closes its commands first, before Escape means Back.
          event.preventDefault();
          setCommands('closed');
        } else if (
          isOpen &&
          (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Enter') &&
          !event.nativeEvent.isComposing
        ) {
          const typed = input.current?.value ?? '';
          if (keys.current?.(event.key, typed)) {
            event.preventDefault();
            return;
          }
          // Enter pressed before the palette has drawn what was typed runs the best match for it.
          const best = event.key === 'Enter' ? bestCommandFor(typed) : undefined;
          if (!best) return;
          event.preventDefault();
          done();
          void best.run();
        }
      }}
    >
      <label {...stylex.props(styles.field)}>
        <Icon icon={Search} size="sm" color="secondary" />
        <input
          ref={input}
          type="search"
          aria-label="Search mail"
          placeholder={isPhone ? 'Search mail' : 'Search and commands'}
          value={text}
          aria-controls={isOpen ? listId : undefined}
          aria-activedescendant={isOpen ? active : undefined}
          onChange={(event) => onSearch(event.target.value)}
          onFocus={() => {
            void loadScope().catch(() => {});
            preloadCommandMatches();
          }}
          enterKeyHint="search"
          autoComplete="off"
          spellCheck={false}
          {...stylex.props(styles.input)}
        />
        {!text && (
          <kbd aria-hidden {...stylex.props(styles.hint)}>
            {shortcutLabel('Mod+K', isApple)}
          </kbd>
        )}
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
      {isOpen && (
        <div {...stylex.props(styles.matches)}>
          <Suspense>
            <CommandMatches
              text={text}
              onDone={done}
              keys={keys}
              id={listId}
              onActive={setActive}
            />
          </Suspense>
        </div>
      )}
    </div>
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
  palette: {
    position: 'relative',
  },
  // The commands lie over what's below the field, on a sheet of their own, so nothing moves.
  matches: {
    position: 'absolute',
    insetInline: 0,
    top: `calc(100% + ${spacingVars['--spacing-1']})`,
    zIndex: 1,
    borderRadius: tm.sheetRadius,
    backgroundColor: colorVars['--color-background-surface'],
    boxShadow: tm.sheetEdge,
    outline: {
      default: null,
      [media.forcedColors]: `${borderVars['--border-width']} solid CanvasText`,
    },
    ':empty': { display: 'none' },
  },
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
  hint: {
    display: { default: 'inline', [media.phone]: 'none' },
    color: colorVars['--color-text-secondary'],
    fontFamily: typographyVars['--font-family-body'],
    fontSize: typeScaleVars['--text-supporting-size'],
    whiteSpace: 'nowrap',
  },
  mark: {
    backgroundColor: { default: tm.highlight, [media.forcedColors]: 'Mark' },
    color: { default: tm.onHighlight, [media.forcedColors]: 'MarkText' },
    borderRadius: radiusVars['--radius-inner'],
    boxShadow: `0 0 0 1px ${tm.highlight}`,
  },
});
