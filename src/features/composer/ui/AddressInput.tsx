import { useLayer } from '@astryxdesign/core/Layer';
import {
  colorVars,
  radiusVars,
  shadowVars,
  spacingVars,
  typeScaleVars,
} from '@astryxdesign/core/theme/tokens.stylex';
import * as stylex from '@stylexjs/stylex';
import type { StyleXStyles } from '@stylexjs/stylex';
import { useQuery } from '@tanstack/react-query';
import { useCallback, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { media, tm } from '../../../app/theme/tokens.stylex.ts';
import type { Address } from '../../mail/core/index.ts';
import { peopleQuery } from '../../mailroom/client/index.ts';
import { completed, completionsFor, typingIn } from '../core/completion.ts';

/**
 * The input of an address field, To, Cc or Bcc, which completes the address being typed from the
 * people the member's mail puts them in touch with. They lie in a list under the field while the
 * member types, and the field keeps the focus: the arrow keys move through them, Enter or Tab picks
 * one, Escape closes the list, and a click or a tap picks any of them.
 */
export function AddressInput({
  value,
  onChange,
  isFocused,
  xstyle,
}: {
  value: string;
  onChange: (value: string) => void;
  isFocused: boolean;
  xstyle: StyleXStyles;
}): ReactNode {
  // Where the caret is while the field has the focus, which says which address is being typed.
  const [caret, setCaret] = useState<number>();
  const typing = caret === undefined ? undefined : typingIn(value, caret);
  const query = typing?.query ?? '';
  const isAsking = /[\p{L}\p{N}]/u.test(query);
  const { data: found = [] } = useQuery({
    ...peopleQuery(query),
    enabled: isAsking,
    // While more is typed of the same address, its last list stays until the next arrives.
    placeholderData: (previous, last) =>
      last && query.startsWith(last.queryKey[1]) ? previous : undefined,
  });
  const people = typing && isAsking ? completionsFor(value, typing, found) : [];
  // Escape closes the list for what has been typed, and typing more opens it again.
  const [closedFor, setClosedFor] = useState<string>();
  const isOpen = people.length > 0 && query !== closedFor;
  // The first person is highlighted again whenever the typing changes.
  const [highlight, setHighlight] = useState({ query, at: 0 });
  const at = highlight.query === query ? Math.min(highlight.at, people.length - 1) : 0;

  const input = useRef<HTMLInputElement | null>(null);
  const placed = useRef<number>(undefined);
  const pick = (person: Address) => {
    if (!typing) return;
    const next = completed(value, typing, person);
    placed.current = next.caret;
    setCaret(next.caret);
    onChange(next.field);
  };
  // A pick puts the caret after it once the field shows it.
  useLayoutEffect(() => {
    const place = placed.current;
    if (place === undefined) return;
    placed.current = undefined;
    input.current?.setSelectionRange(place, place);
  }, [value]);

  // The list lies in a layer of its own, which no pane's overflow clips and the phone's keyboard
  // leaves room for. It is the layer a tooltip uses, which the first load already holds, rather than
  // a popover, whose focus trap and close button the list has no use for.
  const layer = useLayer({
    mode: 'context',
    // The field keeps the focus and closes the list itself, and the browser's light dismiss would
    // count a press in the field as outside it.
    lightDismiss: false,
  });
  const { ref: anchor, show, hide, isOpen: isShown } = layer;
  const ref = useCallback(
    (element: HTMLInputElement | null) => {
      input.current = element;
      anchor(element);
    },
    [anchor],
  );
  useLayoutEffect(() => {
    if (isOpen && !isShown) show();
    else if (!isOpen && isShown) hide();
  }, [isOpen, isShown, show, hide]);
  const listId = useId();
  const optionId = (place: number) => `${listId}-${place}`;
  // The highlight stays in sight where the keyboard leaves the list too little room for all.
  useLayoutEffect(() => {
    if (isOpen) document.getElementById(`${listId}-${at}`)?.scrollIntoView({ block: 'nearest' });
  }, [isOpen, listId, at]);

  const follow = (event: { currentTarget: HTMLInputElement }) =>
    setCaret(event.currentTarget.selectionStart ?? undefined);
  return (
    <>
      <input
        ref={ref}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={isOpen}
        aria-controls={isOpen ? listId : undefined}
        aria-activedescendant={isOpen ? optionId(at) : undefined}
        value={value}
        onChange={(event) => {
          follow(event);
          onChange(event.target.value);
        }}
        onSelect={follow}
        onFocus={follow}
        onBlur={() => setCaret(undefined)}
        onKeyDown={(event) => {
          if (!isOpen || event.nativeEvent.isComposing) return;
          const person = people[at];
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            const step = event.key === 'ArrowDown' ? 1 : people.length - 1;
            setHighlight({ query, at: (at + step) % people.length });
          } else if (
            person &&
            ((event.key === 'Enter' && !event.metaKey && !event.ctrlKey) ||
              (event.key === 'Tab' && !event.shiftKey))
          ) {
            pick(person);
          } else if (event.key === 'Escape') {
            // The list closes first, before Escape closes the composer.
            setClosedFor(query);
          } else {
            return;
          }
          event.preventDefault();
        }}
        autoComplete="off"
        autoFocus={isFocused}
        spellCheck={false}
        {...stylex.props(xstyle)}
      />
      {people.length > 0 &&
        layer.render(
          <ul role="listbox" id={listId} aria-label="People" {...stylex.props(styles.list)}>
            {people.map((person, place) => (
              <li
                key={person.email}
                id={optionId(place)}
                role="option"
                aria-selected={place === at}
                // The field keeps the focus, so typing goes on while the pointer picks.
                onMouseDown={(event) => event.preventDefault()}
                onMouseMove={() => {
                  if (place !== at) setHighlight({ query, at: place });
                }}
                onClick={(event) => {
                  // The field's label would otherwise take the click too.
                  event.preventDefault();
                  pick(person);
                }}
                {...stylex.props(styles.person, place === at && styles.highlighted)}
              >
                <span {...stylex.props(styles.name)}>{person.name || person.email}</span>
                {person.name && <span {...stylex.props(styles.address)}>{person.email}</span>}
              </li>
            ))}
          </ul>,
          {
            placement: 'below',
            alignment: 'start',
            offset: spacingVars['--spacing-1'],
            xstyle: styles.layer,
          },
        )}
    </>
  );
}

const styles = stylex.create({
  // A sheet as wide as the field, or wider for a long name.
  layer: {
    minWidth: 'anchor-size(width)',
    padding: spacingVars['--spacing-1'],
    borderRadius: radiusVars['--radius-container'],
    backgroundColor: colorVars['--color-background-popover'],
    boxShadow: shadowVars['--shadow-low'],
  },
  list: {
    listStyle: 'none',
    margin: 0,
    padding: 0,
    display: 'flex',
    flexDirection: 'column',
  },
  person: {
    display: 'flex',
    alignItems: 'center',
    gap: spacingVars['--spacing-2'],
    minHeight: tm.target,
    paddingInline: spacingVars['--spacing-2'],
    paddingBlock: spacingVars['--spacing-1'],
    boxSizing: 'border-box',
    borderRadius: radiusVars['--radius-element'],
    backgroundColor: {
      default: 'transparent',
      ':hover': colorVars['--color-overlay-hover'],
    },
    color: colorVars['--color-text-primary'],
    fontSize: typeScaleVars['--text-body-size'],
    cursor: 'pointer',
  },
  // A name keeps its line before its address does.
  name: {
    flexShrink: 0,
    maxWidth: '100%',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  address: {
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    color: tm.textQuiet,
  },
  // The highlighted person, whom Enter picks, in the field's own ring of ink.
  highlighted: {
    backgroundColor: colorVars['--color-overlay-hover'],
    boxShadow: `inset 0 0 0 1px ${colorVars['--color-accent']}`,
    outline: { default: null, [media.forcedColors]: '2px solid Highlight' },
  },
});
