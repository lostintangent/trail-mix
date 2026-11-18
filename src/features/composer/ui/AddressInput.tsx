import { Icon } from '@astryxdesign/core/Icon';
import { useLayer } from '@astryxdesign/core/Layer';
import {
  colorVars,
  fontWeightVars,
  radiusVars,
  shadowVars,
  sizeVars,
  spacingVars,
  typeScaleVars,
} from '@astryxdesign/core/theme/tokens.stylex';
import { VisuallyHidden } from '@astryxdesign/core/VisuallyHidden';
import * as stylex from '@stylexjs/stylex';
import { useQuery } from '@tanstack/react-query';
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { media, tm } from '../../../app/theme/tokens.stylex.ts';
import { LaterTooltip } from '../../../shared/LaterTooltip.tsx';
import type { Address } from '../../mail/core/index.ts';
import { peopleQuery } from '../../mailroom/client/index.ts';
import {
  committed,
  completionsFor,
  editing,
  pasted,
  picked,
  queryOf,
  removed,
  stillNamed,
  typed,
  type AddressField,
  type Chip,
} from '../core/completion.ts';
import { fieldStyles } from './fieldStyles.ts';

/**
 * An address field, To, Cc or Bcc: a chip for each address written, and an input after them that
 * completes the address being typed from the people the member's mail puts them in touch with.
 *
 * The input keeps the focus throughout, so a phone's keyboard stays up. Backspace or the left arrow
 * at its start selects the last chip, the arrows move the selection, and Backspace or Delete
 * removes the chip selected and Enter edits it. A click selects a chip, a double click edits it,
 * and each has a button that removes it. While the member types, the people it completes to lie in
 * a list under the field: the arrow keys move through them, Enter or Tab picks one, Escape closes
 * the list, and a click or a tap picks any of them.
 */
export function AddressInput({
  id,
  label,
  field,
  onChange,
  isFocused,
  refused,
  problem,
}: {
  id: string;
  label: string;
  field: AddressField;
  onChange: (field: AddressField) => void;
  isFocused: boolean;
  /** Where the chip Send refused lies, to select, given anew with each refusal. */
  refused: { at: number; text: string } | undefined;
  /** The text Send refuses, said under the chips while the refusal stands. */
  problem: string | undefined;
}): ReactNode {
  const [hasFocus, setFocus] = useState(false);
  const [selection, select] = useState<number>();
  const selected =
    selection !== undefined && selection < field.chips.length ? selection : undefined;
  // What the field last said of its chips, for a screen reader.
  const [said, say] = useState('');

  const query = hasFocus ? queryOf(field) : '';
  const isAsking = /[\p{L}\p{N}]/u.test(query);
  const { data: found = [] } = useQuery({
    ...peopleQuery(query),
    enabled: isAsking,
    // While more is typed of the same address, those of its last list it still names stay until
    // the next arrives.
    placeholderData: (previous, last) =>
      previous && last && query.startsWith(last.queryKey[1])
        ? stillNamed(previous, query)
        : undefined,
  });
  const people = isAsking ? completionsFor(field, found) : [];
  // Escape closes the list for what has been typed, and typing more opens it again.
  const [closedFor, setClosedFor] = useState<string>();
  const isOpen = people.length > 0 && query !== closedFor;
  // The first person is highlighted again whenever the typing changes.
  const [highlight, setHighlight] = useState({ query, at: 0 });
  const at = highlight.query === query ? Math.min(highlight.at, people.length - 1) : 0;

  const input = useRef<HTMLInputElement | null>(null);
  const change = (next: AddressField) => {
    select(undefined);
    onChange(next);
  };
  const pick = (person: Address) => change(picked(field, person));
  const remove = (place: number) => {
    const chip = field.chips[place];
    if (chip) say(`Removed ${spoken(chip)}`);
    change(removed(field, place));
  };
  // An edited chip goes back to be typed, with the caret after it.
  const caretAtEnd = useRef(false);
  const edit = (place: number) => {
    caretAtEnd.current = true;
    input.current?.focus();
    change(editing(field, place));
  };
  useLayoutEffect(() => {
    if (!caretAtEnd.current) return;
    caretAtEnd.current = false;
    input.current?.setSelectionRange(field.typing.length, field.typing.length);
  }, [field.typing]);
  const choose = (place: number | undefined) => {
    const chip = place === undefined ? undefined : field.chips[place];
    select(place);
    if (chip) say(`${spoken(chip)}, selected`);
  };
  // Send selects the chip it refused, for the member to fix or remove, and says why under the chips.
  useEffect(() => {
    if (!refused) return;
    input.current?.focus();
    select(refused.at);
    say(refusalOf(refused.text));
  }, [refused]);

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
  const countId = `${listId}-count`;
  const problemId = `${listId}-problem`;
  // The highlight stays in sight where the keyboard leaves the list too little room for all.
  useLayoutEffect(() => {
    if (isOpen) document.getElementById(`${listId}-${at}`)?.scrollIntoView({ block: 'nearest' });
  }, [isOpen, listId, at]);

  /** The keys of a chip selected: the arrows move the selection, and others act on the chip. */
  const onChipKey = (event: React.KeyboardEvent, place: number) => {
    const isPlain = !event.metaKey && !event.ctrlKey && !event.altKey;
    if (event.key === 'ArrowLeft' && isPlain) choose(Math.max(0, place - 1));
    else if (event.key === 'ArrowRight' && isPlain) {
      choose(place < field.chips.length - 1 ? place + 1 : undefined);
    } else if ((event.key === 'Backspace' || event.key === 'Delete') && isPlain) remove(place);
    else if (event.key === 'Enter' && isPlain && !event.shiftKey) edit(place);
    else if (event.key === 'Escape') select(undefined);
    else {
      // Anything else, typing included, goes to the input as it would have.
      if (!MODIFIERS.has(event.key)) select(undefined);
      return;
    }
    event.preventDefault();
  };

  return (
    <div {...stylex.props(styles.field)}>
      {/* The chips and the input flow together, as Astryx's Tokenizer lays out its tokens, so
          what's typed follows the last chip. A press between them lands in the input, as on a
          field's box. */}
      <div
        role="group"
        aria-label={label}
        onMouseDown={(event) => {
          if (event.target !== event.currentTarget) return;
          event.preventDefault();
          input.current?.focus();
        }}
        {...stylex.props(styles.box)}
      >
        {field.chips.map((chip, place) => (
          <AddressChip
            key={'address' in chip ? chip.address.email.toLowerCase() : `${place}:${chip.text}`}
            chip={chip}
            isSelected={place === selected}
            onSelect={() => {
              input.current?.focus();
              choose(place);
            }}
            onEdit={() => edit(place)}
            onRemove={() => remove(place)}
          />
        ))}
        <input
          ref={ref}
          id={id}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={isOpen}
          aria-controls={isOpen ? listId : undefined}
          aria-activedescendant={isOpen ? optionId(at) : undefined}
          // The field says how many it holds, and why Send refused it.
          aria-describedby={problem ? `${problemId} ${countId}` : countId}
          aria-invalid={problem ? true : undefined}
          value={field.typing}
          onChange={(event) => change(typed(field, event.target.value))}
          onPaste={(event) => {
            const { value, selectionStart, selectionEnd } = event.currentTarget;
            const text = event.clipboardData.getData('text/plain');
            const typing =
              value.slice(0, selectionStart ?? value.length) +
              text +
              value.slice(selectionEnd ?? value.length);
            // A paste of several addresses makes a chip of each, and any other pastes as it would.
            const next = pasted(field, typing);
            if (!next) return;
            event.preventDefault();
            change(next);
          }}
          onFocus={() => setFocus(true)}
          onBlur={(event) => {
            setFocus(false);
            select(undefined);
            // What's typed becomes a chip as the member leaves the field, though not as the window
            // loses the focus, which leaves it where it was.
            if (field.typing.trim() !== '' && document.activeElement !== event.currentTarget) {
              change(committed(field));
            }
          }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (selected !== undefined) return onChipKey(event, selected);
            const person = people[at];
            const isPlain = !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey;
            const { selectionStart, selectionEnd } = event.currentTarget;
            if (isOpen && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
              const step = event.key === 'ArrowDown' ? 1 : people.length - 1;
              setHighlight({ query, at: (at + step) % people.length });
            } else if (
              isOpen &&
              person &&
              ((event.key === 'Enter' && !event.metaKey && !event.ctrlKey) ||
                (event.key === 'Tab' && !event.shiftKey))
            ) {
              pick(person);
            } else if (isOpen && event.key === 'Escape') {
              // The list closes first, before Escape closes the composer.
              setClosedFor(query);
            } else if (event.key === 'Enter' && isPlain && field.typing.trim() !== '') {
              change(committed(field));
            } else if (
              (event.key === 'Backspace' || event.key === 'ArrowLeft') &&
              isPlain &&
              selectionStart === 0 &&
              selectionEnd === 0 &&
              field.chips.length > 0
            ) {
              choose(field.chips.length - 1);
            } else {
              return;
            }
            event.preventDefault();
          }}
          autoComplete="off"
          autoFocus={isFocused}
          spellCheck={false}
          {...stylex.props(fieldStyles.input, styles.input([...field.typing].length + 4))}
        />
        <VisuallyHidden role="status">{said}</VisuallyHidden>
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
                  onClick={() => pick(person)}
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
      </div>
      {problem && (
        <p id={problemId} {...stylex.props(styles.problem)}>
          {refusalOf(problem)}
        </p>
      )}
      <span id={countId} hidden>
        {countOf(field.chips)}
      </span>
    </div>
  );
}

/**
 * One chip: the name, or the address where there's none, with the address on hover and to a screen
 * reader. Text that names no address shows in red, and says so.
 *
 * It draws Astryx's Token itself, with Astryx's tokens: Token's palette of colors, which no chip
 * uses, would lie in the stylesheet that blocks the first paint.
 */
function AddressChip({
  chip,
  isSelected,
  onSelect,
  onEdit,
  onRemove,
}: {
  chip: Chip;
  isSelected: boolean;
  onSelect: () => void;
  onEdit: () => void;
  onRemove: () => void;
}) {
  const anchor = useRef<HTMLElement | null>(null);
  const isAddress = 'address' in chip;
  const name = isAddress ? chip.address.name || chip.address.email : chip.text;
  const detail = isAddress
    ? chip.address.name
      ? chip.address.email
      : undefined
    : 'Not an address';
  return (
    <span
      data-chip
      // The input keeps the focus, and the chip is selected in it.
      onMouseDown={(event) => event.preventDefault()}
      onClick={(event) => {
        if (!isRemove(event.target)) onSelect();
      }}
      onDoubleClick={(event) => {
        if (!isRemove(event.target)) onEdit();
      }}
      {...stylex.props(styles.item)}
    >
      <span
        ref={anchor}
        {...stylex.props(styles.chip, !isAddress && styles.invalid, isSelected && styles.selected)}
      >
        {!isAddress && <Icon icon="error" size="xsm" color="inherit" />}
        <span {...stylex.props(styles.label)}>{name}</span>
        <button
          type="button"
          // Backspace and Delete remove the chip selected, so the button needs no Tab stop.
          tabIndex={-1}
          aria-label={`Remove ${name}`}
          onClick={onRemove}
          data-remove
          {...stylex.props(styles.remove)}
        >
          <Icon icon="close" size="xsm" color="inherit" />
        </button>
      </span>
      {detail && <VisuallyHidden>{`, ${detail}`}</VisuallyHidden>}
      {detail && <LaterTooltip anchor={anchor} content={detail} />}
    </span>
  );
}

/** How a chip reads aloud: its name and address, or its text and that it names none. */
const spoken = (chip: Chip) =>
  'address' in chip
    ? [chip.address.name, chip.address.email].filter(Boolean).join(', ')
    : `${chip.text}, not an address`;

/** Why Send refused text in the field. */
const refusalOf = (text: string) => `“${text}” isn’t an address`;

/** How many addresses a field holds, and how many chips name none, as a screen reader hears it. */
function countOf(chips: readonly Chip[]): string {
  const none = chips.filter((chip) => !('address' in chip)).length;
  const some = chips.length - none;
  return [
    some > 0 && `${some} ${some === 1 ? 'address' : 'addresses'}`,
    none > 0 && `${none} ${none === 1 ? 'not an address' : 'not addresses'}`,
  ]
    .filter(Boolean)
    .join(', ');
}

const isRemove = (target: EventTarget) =>
  target instanceof Element && target.closest('[data-remove]') !== null;

const MODIFIERS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'CapsLock']);

const styles = stylex.create({
  // The chips, and under them why Send refused one, beside the field's name.
  field: {
    flexGrow: 1,
    minWidth: 0,
    display: 'flex',
    flexDirection: 'column',
  },
  // The chips and the input wrap in the line beside the field's name.
  box: {
    minWidth: 0,
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    columnGap: { default: spacingVars['--spacing-1'], [media.coarse]: spacingVars['--spacing-2'] },
    cursor: 'text',
  },
  // Each line of chips is as tall as a line of the header.
  item: {
    display: 'flex',
    alignItems: 'center',
    minWidth: 0,
    maxWidth: '100%',
    minHeight: tm.target,
  },
  // Beside the last chip while what's typed fits there, from a few characters, and on a line of
  // its own once it needs more.
  input: (characters: number) => ({
    flexBasis: `${characters}ch`,
  }),
  // Wrapping as it needs to, so a narrow phone shows all of it.
  problem: {
    margin: 0,
    paddingBlockEnd: spacingVars['--spacing-1'],
    color: colorVars['--color-text-red'],
    fontSize: typeScaleVars['--text-supporting-size'],
    lineHeight: typeScaleVars['--text-supporting-leading'],
    overflowWrap: 'anywhere',
  },
  // Astryx's Token at its middle size, on the neutral plate. The remove button's target reaches
  // past the chip under a finger.
  chip: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: spacingVars['--spacing-1'],
    minWidth: 0,
    maxWidth: '100%',
    boxSizing: 'border-box',
    height: `calc(${sizeVars['--size-element-md']} - 8px)`,
    paddingInline: spacingVars['--spacing-2'],
    borderRadius: radiusVars['--radius-inner'],
    backgroundColor: colorVars['--color-neutral'],
    color: colorVars['--color-text-primary'],
    fontSize: typeScaleVars['--text-supporting-size'],
    lineHeight: typeScaleVars['--text-supporting-leading'],
    fontWeight: fontWeightVars['--font-weight-medium'],
    whiteSpace: 'nowrap',
    cursor: 'default',
    borderWidth: { default: 0, [media.forcedColors]: '1px' },
    borderStyle: { default: 'none', [media.forcedColors]: 'solid' },
    borderColor: { default: null, [media.forcedColors]: 'CanvasText' },
  },
  invalid: {
    backgroundColor: colorVars['--color-background-red'],
    color: colorVars['--color-text-red'],
  },
  label: {
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  // The chip Backspace or Delete would remove, in the field's own ring of ink.
  selected: {
    boxShadow: `inset 0 0 0 2px ${colorVars['--color-accent']}`,
    outline: { default: null, [media.forcedColors]: '2px solid Highlight' },
    outlineOffset: { default: null, [media.forcedColors]: '1px' },
  },
  remove: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    position: 'relative',
    flexShrink: 0,
    padding: 0,
    borderWidth: 0,
    borderRadius: radiusVars['--radius-full'],
    backgroundColor: {
      default: 'transparent',
      ':hover': colorVars['--color-overlay-hover'],
    },
    color: 'inherit',
    cursor: 'pointer',
    // Under a finger the button is a target of 44 pixels, overflowing the chip around its cross.
    width: { default: '16px', [media.coarse]: '44px' },
    height: { default: '16px', [media.coarse]: '44px' },
    marginInlineEnd: {
      default: `calc(-1 * ${spacingVars['--spacing-1']})`,
      [media.coarse]: `calc(-1 * ${spacingVars['--spacing-2']} - 6px)`,
    },
    '::after': {
      content: '""',
      position: 'absolute',
      inset: { default: '-4px', [media.coarse]: 0 },
    },
  },
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
