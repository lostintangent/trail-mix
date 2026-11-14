import { Button } from '@astryxdesign/core/Button';
import { Icon } from '@astryxdesign/core/Icon';
import { IconButton } from '@astryxdesign/core/IconButton';
import {
  fontWeightVars,
  radiusVars,
  spacingVars,
  typeScaleVars,
} from '@astryxdesign/core/theme/tokens.stylex';
import { VisuallyHidden } from '@astryxdesign/core/VisuallyHidden';
import * as stylex from '@stylexjs/stylex';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, CircleAlert, Clock, CloudOff, Send, Undo2, X, type LucideIcon } from 'lucide-react';
import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from 'react';
import { tooltipOf, UNDO_COMMAND, useCommands } from '../../commands/index.ts';
import type { Address } from '../../mail/core/index.ts';
import { conversationQuery, foldersQuery, outboxQuery } from '../../mailroom/client/index.ts';
import { formatAhead } from '../core/later.ts';
import {
  briefly,
  follow,
  followed,
  isLeaving,
  isOnItsWay,
  isUndoable,
  standingOfFollowed,
  standingOfPress,
  standingOfWait,
  type Followed,
  type Standing,
} from '../core/standing.ts';
import { media } from '../../../app/theme/tokens.stylex.ts';
import { ToastRule } from '../../../shared/ToastRule.tsx';
import { Airmail } from './Airmail.tsx';
import { unreachedOf, useAsked } from './asked.ts';
import { undo as undoSend } from './undo.ts';
import { offerUndo } from './undoable.ts';

/** How long a toast stays once there is nothing left to do in it. */
const LINGER_MS: Partial<Record<Standing['is'], number>> = {
  scheduled: 6_000,
  sent: 4_000,
  undone: 4_000,
};
/** How long a toast waits for a sign that a send gone from the Outbox went, before it gives up. */
const GONE_MS = 30_000;
/** How often the toast asks for the conversation while it waits for the send's copy in Sent. */
const CHECK_MS = 2_000;
/** How often the countdown looks at the clock, so each second turns over on time. */
const TICK_MS = 250;

/**
 * The toast that follows a send from the device that asked for it, while the member is away from
 * its conversation. From the press, through the undo window, it counts down with Undo, and for a
 * send later it says when. Then it says what the Mailroom has shown: that it's sending, that it
 * went, or why it didn't, with the way to the Outbox. Airmail lies along its top while the message
 * is leaving, and runs while it's on its way. It starts from what the device has seen of the send
 * so far, and goes if the hand-off fails, whose own toast says why.
 */
export default function LeavingToast({
  id,
  to,
  seen: seenFirst,
  closes,
  dismiss,
}: {
  /** The press. */
  id: string;
  /** Whom the press sent it to. */
  to: readonly Address[];
  seen: Followed | undefined;
  /** When the undo window closes on this device's clock. */
  closes: number;
  dismiss: () => void;
}) {
  const queryClient = useQueryClient();
  const [seen, setSeen] = useState(seenFirst);
  const [undo, setUndo] = useState<'idle' | 'asking' | 'done' | { refused: string }>('idle');
  const [now, setNow] = useState(Date.now);
  const hand = useAsked(id)?.hand;
  const outgoing = seen?.last;

  // The workbench asks after a send under way, in case a hint is lost, and the toast follows,
  // from the first snapshot that holds the send its press asked for, which the press names unless
  // the Mailroom held a send of the same draft already.
  const { data: outbox, dataUpdatedAt } = useQuery(outboxQuery);
  const asked = hand?.is === 'asked' ? hand.send.id : id;
  useEffect(() => {
    if (!outbox) return;
    setSeen((was) => {
      if (was)
        return follow(
          was,
          outbox.find((held) => held.id === was.last.id),
          dataUpdatedAt,
        );
      const held = outbox.find((each) => each.id === asked);
      return held && followed(held);
    });
  }, [outbox, dataUpdatedAt, asked]);

  // Gone without a sign that it went, the send went if Sent holds its copy.
  const isAwaitingCopy = seen?.goneAt !== undefined && !seen.hasBegun;
  const conversation = seen?.last.conversation;
  const { data: messages } = useQuery({
    ...conversationQuery(conversation ?? ''),
    enabled: isAwaitingCopy && conversation !== undefined,
    refetchInterval: CHECK_MS,
  });
  const folders = useQuery(foldersQuery).data;
  const isInSent =
    isAwaitingCopy &&
    (messages ?? []).some(
      (message) =>
        message.messageId === outgoing?.messageId &&
        folders?.some(
          ({ account, path, role }) =>
            role === 'sent' && account === message.account && path === message.path,
        ),
    );

  // Until the Outbox shows the send, this device may still be asking the Mailroom for it.
  const standing: Standing =
    undo === 'done'
      ? { is: 'undone' }
      : seen
        ? standingOfFollowed(seen, closes, now, isInSent)
        : standingOfPress(
            standingOfWait(new Date(closes).toISOString(), closes, now),
            unreachedOf(hand),
          );

  const isTicking =
    standing.is === 'counting' || (standing.is === 'unreached' && standing.isWaiting);
  useEffect(() => {
    if (!isTicking) return;
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, [isTicking]);
  const linger = isAwaitingCopy && standing.is === 'sending' ? GONE_MS : LINGER_MS[standing.is];
  const leave = useEffectEvent(dismiss);
  useEffect(() => {
    if (linger === undefined) return;
    const timer = setTimeout(leave, linger);
    return () => clearTimeout(timer);
  }, [linger]);
  const hasFailed = hand?.is === 'failed';
  useEffect(() => {
    if (hasFailed) leave();
  }, [hasFailed]);

  const takeBack = async () => {
    setUndo('asking');
    const refused = await undoSend(queryClient, id);
    setUndo(refused === undefined ? 'done' : { refused });
  };

  // While it counts, Undo in the registry, and its key, take this send back too.
  const latestTakeBack = useRef(takeBack);
  useLayoutEffect(() => {
    latestTakeBack.current = takeBack;
  });
  const canTakeBack = isUndoable(standing) && undo === 'idle';
  useEffect(() => {
    if (!canTakeBack) return;
    return offerUndo({ id, takeBack: () => void latestTakeBack.current() });
  }, [canTakeBack, id]);
  const commands = useCommands();
  const goToOutbox = commands.find(({ id }) => id === 'go.outbox');
  const undoCommand = commands.find(({ id }) => id === UNDO_COMMAND);

  const who = briefly(outgoing?.to ?? to);
  const refused = typeof undo === 'object' ? undo.refused : undefined;
  const { icon, text: status } = said(standing, who);
  // A refused Undo stays said, as the send goes on to whatever it comes to.
  const text = refused ? `${refused} ${status}` : status;
  return (
    <div {...stylex.props(styles.card)}>
      {isLeaving(standing) && <Airmail isRunning={isOnItsWay(standing)} />}
      <div {...stylex.props(styles.row)}>
        <div {...stylex.props(styles.said)}>
          <Icon icon={icon} size="sm" color="inherit" />
          <span {...stylex.props(styles.text)}>{text}</span>
        </div>
        {/* The countdown's seconds aren't announced, and what follows them is, once. */}
        <VisuallyHidden role="status">
          {standing.is === 'counting' || standing.is === 'scheduled' ? '' : text}
        </VisuallyHidden>
        <div {...stylex.props(styles.actions)}>
          {isUndoable(standing) && undo !== 'done' ? (
            <>
              <IconButton
                label="Undo"
                tooltip={undoCommand ? tooltipOf(undoCommand) : 'Undo'}
                icon={<Icon icon={Undo2} size="sm" color="inherit" />}
                variant="ghost"
                size="sm"
                isLoading={undo === 'asking'}
                onClick={() => void takeBack()}
              />
              <ToastRule />
            </>
          ) : goToOutbox && (standing.is === 'failed' || standing.is === 'retrying') ? (
            <>
              <Button
                label="Open Outbox"
                variant="ghost"
                size="sm"
                onClick={() => {
                  dismiss();
                  void goToOutbox.run();
                }}
                xstyle={styles.action}
              />
              <ToastRule />
            </>
          ) : null}
          <Button
            label="Dismiss"
            icon={<Icon icon={X} size="sm" color="inherit" />}
            isIconOnly
            variant="ghost"
            size="sm"
            onClick={dismiss}
          />
        </div>
      </div>
    </div>
  );
}

/** What the toast says, and the icon beside it, for where the send stands. */
export function said(standing: Standing, who: string): { icon: LucideIcon; text: string } {
  switch (standing.is) {
    case 'counting':
      return { icon: Send, text: `Sending to ${who} in ${standing.seconds}s` };
    case 'scheduled':
      return { icon: Clock, text: `Sending to ${who} ${formatAhead(standing.at)}` };
    case 'sending':
      return { icon: Send, text: `Sending to ${who}…` };
    case 'sent':
      return { icon: Check, text: `Sent to ${who}` };
    case 'retrying':
      return { icon: CircleAlert, text: `Not sent to ${who} yet. ${standing.error} Trying again.` };
    case 'failed':
      return { icon: CircleAlert, text: `Couldn’t send to ${who}. ${standing.error}` };
    case 'undone':
      return { icon: Undo2, text: `Undone. Nothing was sent to ${who}.` };
    case 'unreached':
      return {
        icon: CloudOff,
        text: `Can’t reach Trail Mix to send to ${who}. ${standing.error} Trying again.`,
      };
  }
}

const styles = stylex.create({
  // The card's own padding gives way to the stripe, which runs edge to edge under its corners.
  card: {
    margin: `calc(-1 * ${spacingVars['--spacing-4']})`,
    overflow: 'hidden',
    borderRadius: radiusVars['--radius-container'],
  },
  // What it says, then what it offers. On a phone, what it says takes the card's width when it
  // can't share a line with them, and they sit at the end of a line beneath it.
  row: {
    display: 'flex',
    flexWrap: { default: 'nowrap', [media.phone]: 'wrap' },
    alignItems: 'center',
    columnGap: spacingVars['--spacing-2'],
    rowGap: spacingVars['--spacing-1'],
    paddingBlock: spacingVars['--spacing-2'],
    paddingInlineStart: spacingVars['--spacing-4'],
    paddingInlineEnd: spacingVars['--spacing-2'],
  },
  said: {
    display: 'flex',
    alignItems: 'center',
    gap: spacingVars['--spacing-2'],
    flexGrow: 1,
    minWidth: 0,
  },
  text: {
    minWidth: 0,
    fontSize: typeScaleVars['--text-body-size'],
    fontVariantNumeric: 'tabular-nums',
  },
  // Beside it, a long reason wraps rather than squeezing them.
  actions: {
    display: 'flex',
    alignItems: 'center',
    gap: spacingVars['--spacing-2'],
    flexShrink: 0,
    marginInlineStart: 'auto',
  },
  action: {
    fontWeight: fontWeightVars['--font-weight-semibold'],
  },
});
