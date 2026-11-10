import { Button } from '@astryxdesign/core/Button';
import { Dialog, DialogHeader } from '@astryxdesign/core/Dialog';
import { DropdownMenu, type DropdownMenuOption } from '@astryxdesign/core/DropdownMenu';
import { Icon } from '@astryxdesign/core/Icon';
import {
  borderVars,
  colorVars,
  durationVars,
  easeVars,
  fontWeightVars,
  radiusVars,
  spacingVars,
  typeScaleVars,
  typographyVars,
} from '@astryxdesign/core/theme/tokens.stylex';
import * as stylex from '@stylexjs/stylex';
import { Clock, Send } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { media, tm } from '../../../app/theme/tokens.stylex.ts';
import { isApple, shortcutLabel, type Command } from '../../commands/index.ts';
import { instantOf } from '../core/later.ts';
import { SEND, SEND_LATER } from './sendCommands.ts';
import { loadSending } from './useSend.ts';

/**
 * Send, and Send later beside it, drawn from the send commands: each time ahead they offer, or a
 * date and time picked in the member's own time zone, which goes to the Mailroom as an instant. A
 * time already past sends now, through the undo window. Where room is short, Send later is an icon,
 * and Send keeps its word, as the main action.
 */
export function SendActions({
  commands,
  onPick,
  isCompact = false,
}: {
  /** From `sendCommands`. */
  commands: readonly Command[];
  /** Sends at a picked time. */
  onPick: (at: string) => void;
  isCompact?: boolean;
}) {
  const [isPicking, setPicking] = useState(false);
  // Sending can't wait for its code once Send is pressed.
  useEffect(() => void loadSending(), []);
  const send = commands.find(({ id }) => id === SEND);
  if (!send) return null;
  const isEnabled = send.isEnabled !== false;
  const later: DropdownMenuOption[] = [
    ...commands
      .filter(({ id }) => id.startsWith(SEND_LATER))
      .map(({ id, title, run }) => ({ id, label: title, onClick: () => void run() })),
    { type: 'divider' },
    { id: 'pick', label: 'Pick a date and time…', onClick: () => setPicking(true) },
  ];
  const tooltip = send.shortcut ? `Send (${shortcutLabel(send.shortcut, isApple)})` : undefined;
  return (
    <span {...stylex.props(styles.actions)}>
      <DropdownMenu
        button={{
          label: 'Send later',
          tooltip: isCompact ? 'Send later' : undefined,
          icon: <Icon icon={Clock} />,
          isIconOnly: isCompact,
          variant: 'ghost',
          isDisabled: !isEnabled,
        }}
        hasChevron={false}
        items={later}
      />
      <Button
        label={send.title}
        tooltip={tooltip}
        icon={<Icon icon={Send} />}
        variant="primary"
        isDisabled={!isEnabled}
        onClick={() => void send.run()}
      />
      {isPicking && (
        <PickTime
          onPick={(at) => {
            setPicking(false);
            onPick(at);
          }}
          onClose={() => setPicking(false)}
        />
      )}
    </span>
  );
}

/**
 * A date and time to send at, starting from the next whole hour. The field is the platform's own,
 * drawn with Astryx's input tokens, so a phone offers its own picker.
 */
function PickTime({ onPick, onClose }: { onPick: (at: string) => void; onClose: () => void }) {
  const [value, setValue] = useState(() => localInput(nextHour()));
  const fieldId = useId();
  return (
    <Dialog
      isOpen
      onOpenChange={(open) => !open && onClose()}
      purpose="form"
      width="min(360px, 100%)"
    >
      <DialogHeader title="Send later" onOpenChange={() => onClose()} />
      <form
        {...stylex.props(styles.form)}
        onSubmit={(event) => {
          event.preventDefault();
          if (value) onPick(instantOf(value));
        }}
      >
        <span {...stylex.props(styles.field)}>
          <label htmlFor={fieldId} {...stylex.props(styles.label)}>
            Send at
          </label>
          <input
            id={fieldId}
            type="datetime-local"
            required
            value={value}
            min={localInput(new Date())}
            onChange={(event) => setValue(event.target.value)}
            {...stylex.props(styles.input)}
          />
        </span>
        <span {...stylex.props(styles.buttons)}>
          <Button label="Cancel" variant="ghost" onClick={onClose} />
          <Button label="Schedule" type="submit" variant="primary" isDisabled={!value} />
        </span>
      </form>
    </Dialog>
  );
}

function nextHour(): Date {
  const at = new Date();
  at.setHours(at.getHours() + 1, 0, 0, 0);
  return at;
}

/** A date as a local date and time field holds it: "2026-11-10T17:00". */
function localInput(date: Date): string {
  const two = (n: number) => String(n).padStart(2, '0');
  const day = `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}`;
  return `${day}T${two(date.getHours())}:${two(date.getMinutes())}`;
}

const styles = stylex.create({
  actions: {
    display: 'flex',
    alignItems: 'center',
    gap: spacingVars['--spacing-1'],
    marginInlineStart: 'auto',
  },
  form: {
    display: 'flex',
    flexDirection: 'column',
    gap: spacingVars['--spacing-4'],
    padding: spacingVars['--spacing-4'],
  },
  buttons: {
    display: 'flex',
    justifyContent: 'flex-end',
    gap: spacingVars['--spacing-2'],
  },
  field: {
    display: 'flex',
    flexDirection: 'column',
    gap: spacingVars['--spacing-1'],
  },
  label: {
    color: colorVars['--color-text-primary'],
    fontSize: typeScaleVars['--text-supporting-size'],
    fontWeight: fontWeightVars['--font-weight-semibold'],
  },
  // As Astryx draws an input: an emphasized edge that turns accent with a muted ring on focus.
  input: {
    boxSizing: 'border-box',
    minHeight: tm.target,
    paddingInline: spacingVars['--spacing-2'],
    borderWidth: borderVars['--border-width'],
    borderStyle: 'solid',
    borderColor: {
      default: colorVars['--color-border-emphasized'],
      ':focus': { default: colorVars['--color-accent'], [media.forcedColors]: 'Highlight' },
    },
    borderRadius: radiusVars['--radius-element'],
    outline: 'none',
    boxShadow: {
      default: 'none',
      ':focus': `inset 0 0 0 2px ${colorVars['--color-accent-muted']}`,
    },
    backgroundColor: colorVars['--color-background-surface'],
    color: colorVars['--color-text-primary'],
    fontFamily: typographyVars['--font-family-body'],
    // A phone zooms into a field whose text is smaller than 16px, so the body size holds there.
    fontSize: typeScaleVars['--text-body-size'],
    transitionProperty: 'border-color, box-shadow',
    transitionDuration: {
      default: durationVars['--duration-fast'],
      [media.reducedMotion]: '0s',
    },
    transitionTimingFunction: easeVars['--ease-standard'],
  },
});
