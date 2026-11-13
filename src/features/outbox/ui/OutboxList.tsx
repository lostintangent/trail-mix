import { Button } from '@astryxdesign/core/Button';
import { EmptyState } from '@astryxdesign/core/EmptyState';
import { Icon } from '@astryxdesign/core/Icon';
import {
  colorVars,
  fontWeightVars,
  radiusVars,
  spacingVars,
  typeScaleVars,
} from '@astryxdesign/core/theme/tokens.stylex';
import * as stylex from '@stylexjs/stylex';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Send } from 'lucide-react';
import { useEffect, useState } from 'react';
import { stampStyles } from '../../../app/theme/stamps.ts';
import { ConversationListSkeleton } from '../../conversations/index.ts';
import { media, tm } from '../../../app/theme/tokens.stylex.ts';
import type { AccountId, ConversationId, Outgoing, StampColor } from '../../mail/core/index.ts';
import { outboxQuery } from '../../mailroom/client/index.ts';
import { formatAhead } from '../core/later.ts';
import { UNDO_SECONDS } from '../core/outbox.ts';
import {
  fully,
  isLeaving,
  isOnItsWay,
  isUndoable,
  standingOf,
  type Standing,
} from '../core/standing.ts';
import { Airmail } from './Airmail.tsx';
import { closesFor } from './asked.ts';
import { outboxActions, type OutboxActions } from './sending.tsx';

/**
 * The Outbox: every send the Mailroom holds, failed ones first, then soonest to go. Each row says
 * whom it's to, its subject and when it goes, and opens its conversation. A send still inside its
 * window or waiting for its time offers Undo. A failed one shows the server's reason, with Retry
 * and Edit, which takes the send back and opens its draft. A send held because its account must be
 * signed in again offers that sign-in instead of Retry. Airmail lies along what is leaving, and runs
 * along what is on its way.
 */
export function OutboxList({
  label,
  stamps,
  lapsed,
  selected,
  onOpen,
  onSignIn,
}: {
  label: string;
  /** Each account's stamp color, by account id. */
  stamps: ReadonlyMap<string, StampColor>;
  /** The accounts waiting for their member to sign in again. */
  lapsed: ReadonlySet<AccountId>;
  onSignIn: (account: AccountId) => void;
  /** The conversation open in the reader, whose row lifts. */
  selected: ConversationId | undefined;
  onOpen: (conversation: ConversationId) => void;
}) {
  const outbox = useQuery(outboxQuery).data;
  const now = useClock(outbox);
  const queryClient = useQueryClient();
  const act = outboxActions(queryClient);
  if (!outbox) return <ConversationListSkeleton label={label} />;
  if (outbox.length === 0) {
    return (
      <div {...stylex.props(styles.empty)}>
        <EmptyState
          icon={<Icon icon={Send} size="lg" color="secondary" />}
          title="Nothing is leaving"
          description="Mail you send waits here through its undo window, or until the time you chose."
        />
      </div>
    );
  }
  const rows = outbox
    .map((outgoing) => ({ outgoing, standing: standingOf(outgoing, closesFor(outgoing), now) }))
    .sort(
      (a, b) =>
        Number(b.standing.is === 'failed') - Number(a.standing.is === 'failed') ||
        a.outgoing.sendAt.localeCompare(b.outgoing.sendAt),
    );
  return (
    <ul aria-label={label} {...stylex.props(styles.list)}>
      {rows.map(({ outgoing, standing }) => (
        <Row
          key={outgoing.id}
          outgoing={outgoing}
          standing={standing}
          stamp={stamps.get(outgoing.draft.account) ?? 'slate'}
          isSelected={outgoing.conversation !== undefined && outgoing.conversation === selected}
          isLapsed={lapsed.has(outgoing.draft.account)}
          onOpen={onOpen}
          onSignIn={() => onSignIn(outgoing.draft.account)}
          act={act}
        />
      ))}
    </ul>
  );
}

function Row({
  outgoing,
  standing,
  stamp,
  isSelected,
  isLapsed,
  onOpen,
  onSignIn,
  act,
}: {
  outgoing: Outgoing;
  standing: Standing;
  stamp: StampColor;
  isSelected: boolean;
  isLapsed: boolean;
  onOpen: (conversation: ConversationId) => void;
  onSignIn: () => void;
  act: OutboxActions;
}) {
  const { conversation, to, subject } = outgoing;
  const error = standing.is === 'failed' || standing.is === 'retrying' ? standing.error : undefined;
  return (
    <li {...stylex.props(styles.row, isSelected && styles.selected)}>
      {isLeaving(standing) && <Airmail isRunning={isOnItsWay(standing)} xstyle={styles.stripe} />}
      <span {...stylex.props(styles.stamp, stampStyles[stamp])} />
      <button
        type="button"
        aria-current={isSelected || undefined}
        disabled={conversation === undefined}
        onClick={() => conversation && onOpen(conversation)}
        {...stylex.props(styles.open)}
      >
        <span {...stylex.props(styles.top)}>
          <span {...stylex.props(styles.to, styles.clip)}>To {fully(to)}</span>
          <span {...stylex.props(styles.when, standing.is === 'failed' && styles.danger)}>
            {when(standing)}
          </span>
        </span>
        <span {...stylex.props(styles.clip)}>{subject || '(no subject)'}</span>
        {error !== undefined && (
          <span {...stylex.props(styles.reason, standing.is === 'failed' && styles.danger)}>
            {error}
          </span>
        )}
      </button>
      <span {...stylex.props(styles.actions)}>
        {isUndoable(standing) && (
          <Button label="Undo" variant="ghost" size="sm" onClick={() => void act.undo(outgoing)} />
        )}
        {error !== undefined && (
          <>
            {isLapsed ? (
              <Button label="Sign in again" variant="secondary" size="sm" onClick={onSignIn} />
            ) : (
              <Button
                label="Retry"
                variant="secondary"
                size="sm"
                onClick={() => void act.retry(outgoing)}
              />
            )}
            <Button
              label="Edit"
              variant="ghost"
              size="sm"
              onClick={() =>
                void act.edit(outgoing).then((isBack) => {
                  if (isBack && conversation) onOpen(conversation);
                })
              }
            />
          </>
        )}
      </span>
    </li>
  );
}

/** When a row's send goes, or how it went. */
function when(standing: Standing): string {
  switch (standing.is) {
    case 'counting':
      return `in ${standing.seconds}s`;
    case 'scheduled':
      return formatAhead(standing.at);
    case 'sending':
      return 'Sending…';
    case 'sent':
      return 'Sent';
    case 'retrying':
      return `Trying again ${formatAhead(standing.at)}`;
    case 'failed':
      return 'Not sent';
    case 'undone':
      return '';
  }
}

/**
 * The time rows are drawn at. It moves on when a row's words would change by time alone: each
 * second of a countdown, and when a scheduled send's last ten seconds begin.
 */
function useClock(outbox: readonly Outgoing[] | undefined): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const changes = (outbox ?? []).flatMap((outgoing) => {
      if (outgoing.state !== 'waiting' || outgoing.error !== undefined) return [];
      const closes = closesFor(outgoing);
      const counts = closes - UNDO_SECONDS * 1000;
      if (now < counts) return [counts];
      if (now >= closes) return [];
      return [closes - Math.floor((closes - now - 1) / 1000) * 1000];
    });
    if (changes.length === 0) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.min(...changes) - now);
    return () => clearTimeout(timer);
  }, [outbox, now]);
  return now;
}

const styles = stylex.create({
  list: {
    display: 'flex',
    flexDirection: 'column',
    gap: spacingVars['--spacing-1'],
    height: '100%',
    overflowY: 'auto',
    overscrollBehavior: 'contain',
    margin: 0,
    paddingBlock: spacingVars['--spacing-1'],
    paddingInline: spacingVars['--spacing-1-5'],
    listStyle: 'none',
  },
  empty: {
    display: 'grid',
    placeItems: 'center',
    height: '100%',
    padding: spacingVars['--spacing-6'],
  },
  row: {
    position: 'relative',
    display: 'grid',
    gridTemplateColumns: '3px minmax(0, 1fr) auto',
    alignItems: 'center',
    gap: spacingVars['--spacing-2'],
    paddingInlineStart: spacingVars['--spacing-1-5'],
    paddingInlineEnd: spacingVars['--spacing-2'],
    borderRadius: radiusVars['--radius-element'],
    overflow: 'hidden',
    color: colorVars['--color-text-primary'],
    fontSize: typeScaleVars['--text-body-size'],
    lineHeight: typeScaleVars['--text-body-leading'],
    backgroundColor: {
      default: 'transparent',
      ':hover': { default: null, '@media (hover: hover)': colorVars['--color-overlay-hover'] },
    },
  },
  // The row whose conversation is open lifts from the sheet onto paper, as in every list.
  selected: {
    backgroundColor: {
      default: colorVars['--color-background-card'],
      ':hover': colorVars['--color-background-card'],
      [media.forcedColors]: 'Highlight',
    },
    boxShadow: `0 0 0 1px ${colorVars['--color-border']}, 0 6px 16px -10px ${tm.shade}`,
    color: { default: null, [media.forcedColors]: 'HighlightText' },
    forcedColorAdjust: 'none',
  },
  stripe: {
    position: 'absolute',
    insetInline: 0,
    top: 0,
  },
  stamp: {
    alignSelf: 'stretch',
    marginBlock: tm.rowPad,
    borderRadius: '2px',
    forcedColorAdjust: 'none',
  },
  open: {
    display: 'flex',
    flexDirection: 'column',
    minWidth: 0,
    minHeight: tm.target,
    paddingBlock: tm.rowPad,
    paddingInline: 0,
    border: 'none',
    backgroundColor: 'transparent',
    color: 'inherit',
    font: 'inherit',
    textAlign: 'start',
    cursor: { default: 'pointer', ':disabled': 'default' },
    outline: { default: 'none', ':focus-visible': `2px solid ${colorVars['--color-accent']}` },
    outlineOffset: '2px',
    borderRadius: radiusVars['--radius-element'],
  },
  top: {
    display: 'flex',
    alignItems: 'baseline',
    gap: spacingVars['--spacing-2'],
    minWidth: 0,
  },
  to: {
    fontWeight: fontWeightVars['--font-weight-medium'],
  },
  when: {
    flexShrink: 0,
    marginInlineStart: 'auto',
    color: tm.textQuiet,
    fontSize: typeScaleVars['--text-supporting-size'],
    fontVariantNumeric: 'tabular-nums',
  },
  reason: {
    color: tm.textQuiet,
    fontSize: typeScaleVars['--text-supporting-size'],
  },
  danger: {
    color: tm.danger,
  },
  clip: {
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  actions: {
    display: 'flex',
    alignItems: 'center',
    gap: spacingVars['--spacing-1'],
  },
});
