import { Button } from '@astryxdesign/core/Button';
import { Icon } from '@astryxdesign/core/Icon';
import {
  fontWeightVars,
  radiusVars,
  spacingVars,
  typeScaleVars,
} from '@astryxdesign/core/theme/tokens.stylex';
import { VisuallyHidden } from '@astryxdesign/core/VisuallyHidden';
import * as stylex from '@stylexjs/stylex';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, CircleAlert, Clock, Send, Undo2, X, type LucideIcon } from 'lucide-react';
import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from 'react';
import { useCommands } from '../../commands/index.ts';
import { reasonOf } from '../../../shared/reasons.ts';
import type { MessageRef, Outgoing } from '../../mail/core/index.ts';
import {
  conversationQuery,
  foldersQuery,
  mailroom,
  outboxQuery,
} from '../../mailroom/client/index.ts';
import { formatAhead } from '../core/later.ts';
import {
  briefly,
  follow,
  followed,
  isLeaving,
  isUndoable,
  standingOfFollowed,
  type Standing,
} from '../core/standing.ts';
import { airmail } from './airmail.ts';
import { offerUndo, withdrawUndo } from './undoable.ts';

/** How long a toast stays once there is nothing left to do in it. */
const LINGER_MS: Partial<Record<Standing['is'], number>> = {
  scheduled: 6_000,
  sent: 4_000,
  undone: 4_000,
};
/** How long a toast waits for a sign that a send gone from the Outbox went, before it gives up. */
const GONE_MS = 30_000;
/** How often the toast asks again while a send is under way, in case a hint is lost. */
const CHECK_MS = 2_000;
/** How often the countdown looks at the clock, so each second turns over on time. */
const TICK_MS = 250;

/**
 * The toast that follows a send from the device that asked for it. Through the undo window it counts
 * down with Undo, and for a send later it says when. Then it says what the Mailroom has shown: that
 * it's sending, that it went, or why it didn't, with the way to the Outbox. Airmail runs along its
 * top while the message is leaving.
 */
export default function LeavingToast({
  outgoing,
  closes,
  dismiss,
  onUndone,
}: {
  outgoing: Outgoing;
  /** When the undo window closes on this device's clock. */
  closes: number;
  dismiss: () => void;
  onUndone: ((draft: MessageRef) => void) | undefined;
}) {
  const queryClient = useQueryClient();
  const [seen, setSeen] = useState(() => followed(outgoing));
  const [undo, setUndo] = useState<'idle' | 'asking' | 'done' | { refused: string }>('idle');
  const [now, setNow] = useState(Date.now);

  const isUnderWay = seen.goneAt !== undefined || seen.last.state !== 'waiting' || now >= closes;
  const { data: outbox, dataUpdatedAt } = useQuery({
    ...outboxQuery,
    refetchInterval: isUnderWay && seen.goneAt === undefined ? CHECK_MS : false,
  });
  useEffect(() => {
    if (outbox)
      setSeen((was) =>
        follow(
          was,
          outbox.find(({ id }) => id === outgoing.id),
          dataUpdatedAt,
        ),
      );
  }, [outbox, dataUpdatedAt, outgoing.id]);

  // Gone without a sign that it went, the send went if Sent holds its copy.
  const isAwaitingCopy = seen.goneAt !== undefined && !seen.hasBegun;
  const conversation = seen.last.conversation;
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
        message.messageId === outgoing.messageId &&
        folders?.some(
          ({ account, path, role }) =>
            role === 'sent' && account === message.account && path === message.path,
        ),
    );

  const standing: Standing =
    undo === 'done' ? { is: 'undone' } : standingOfFollowed(seen, closes, now, isInSent);

  useEffect(() => {
    if (standing.is !== 'counting') return;
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, [standing.is]);
  const linger = isAwaitingCopy && standing.is === 'sending' ? GONE_MS : LINGER_MS[standing.is];
  const leave = useEffectEvent(dismiss);
  useEffect(() => {
    if (linger === undefined) return;
    const timer = setTimeout(leave, linger);
    return () => clearTimeout(timer);
  }, [linger]);

  const takeBack = async () => {
    setUndo('asking');
    try {
      const draft = await mailroom.cancelSend(outgoing.id);
      queryClient.setQueryData(outboxQuery.queryKey, (held) =>
        held?.filter(({ id }) => id !== outgoing.id),
      );
      setUndo('done');
      onUndone?.(draft);
    } catch (error) {
      // An Undo that reached the Mailroom after the window closed was too late, whatever the send
      // has come to since. Anything else says the Mailroom's reason.
      setUndo({
        refused: Date.now() >= closes ? 'Too late to undo.' : `Couldn’t undo. ${reasonOf(error)}`,
      });
      void queryClient.invalidateQueries({ queryKey: outboxQuery.queryKey });
    }
  };

  // While it counts, Undo in the registry, and its key, take this send back too.
  const latestTakeBack = useRef(takeBack);
  useLayoutEffect(() => {
    latestTakeBack.current = takeBack;
  });
  const canTakeBack = isUndoable(standing) && undo === 'idle';
  useEffect(() => {
    if (!canTakeBack) return;
    offerUndo({ id: outgoing.id, takeBack: () => void latestTakeBack.current() });
    return () => withdrawUndo(outgoing.id);
  }, [canTakeBack, outgoing.id]);
  const goToOutbox = useCommands().find(({ id }) => id === 'go.outbox');

  const who = briefly(outgoing.to);
  const refused = typeof undo === 'object' ? undo.refused : undefined;
  const { icon, text: status } = said(standing, who);
  // A refused Undo stays said, as the send goes on to whatever it comes to.
  const text = refused ? `${refused} ${status}` : status;
  return (
    <div {...stylex.props(styles.card)}>
      {isLeaving(standing) && <div {...stylex.props(airmail.stripe)} />}
      <div {...stylex.props(styles.row)}>
        <Icon icon={icon} size="sm" color="inherit" />
        <span {...stylex.props(styles.text)}>{text}</span>
        {/* The countdown's seconds aren't announced, and what follows them is, once. */}
        <VisuallyHidden role="status">
          {standing.is === 'counting' || standing.is === 'scheduled' ? '' : text}
        </VisuallyHidden>
        {isUndoable(standing) && undo !== 'done' ? (
          <Button
            label="Undo"
            variant="ghost"
            size="sm"
            isLoading={undo === 'asking'}
            onClick={() => void takeBack()}
            xstyle={styles.action}
          />
        ) : goToOutbox && (standing.is === 'failed' || standing.is === 'retrying') ? (
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
  );
}

/** What the toast says, and the icon beside it, for where the send stands. */
function said(standing: Standing, who: string): { icon: LucideIcon; text: string } {
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
  }
}

const styles = stylex.create({
  // The card's own padding gives way to the stripe, which runs edge to edge under its corners.
  card: {
    margin: `calc(-1 * ${spacingVars['--spacing-4']})`,
    overflow: 'hidden',
    borderRadius: radiusVars['--radius-container'],
  },
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: spacingVars['--spacing-2'],
    paddingBlock: spacingVars['--spacing-2'],
    paddingInlineStart: spacingVars['--spacing-4'],
    paddingInlineEnd: spacingVars['--spacing-2'],
  },
  text: {
    flexGrow: 1,
    minWidth: 0,
    fontSize: typeScaleVars['--text-body-size'],
    fontVariantNumeric: 'tabular-nums',
  },
  // A long reason wraps beside the action rather than squeezing it.
  action: {
    flexShrink: 0,
    fontWeight: fontWeightVars['--font-weight-semibold'],
  },
});
