import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { CheckboxInput } from '@astryxdesign/core/CheckboxInput';
import { TextInput } from '@astryxdesign/core/TextInput';
import {
  borderVars,
  colorVars,
  fontWeightVars,
  radiusVars,
  spacingVars,
  typeScaleVars,
} from '@astryxdesign/core/theme/tokens.stylex';
import * as stylex from '@stylexjs/stylex';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { media, tm } from '../../../app/theme/tokens.stylex.ts';
import { folded, type Member } from '../core/index.ts';
import { members } from './rpc.ts';

/** Where the operator edits the same list by hand, if the page can't. */
const DASHBOARD = 'https://one.dash.cloudflare.com/';

const listQuery = { queryKey: ['members'], queryFn: () => members.members() } as const;

/**
 * The operator's Members page, on the reader's sheet: who Access lets in by address, with their
 * last sign-in, inviting someone, and removing them, which signs them out at once and can erase
 * what Trail Mix holds for them. Every other way the policy admits people shows in words. The list
 * is read from Access each time, and kept nowhere else.
 */
export function MembersPage() {
  const queryClient = useQueryClient();
  const { data, error, refetch } = useQuery(listQuery);
  const reload = () => void queryClient.invalidateQueries({ queryKey: listQuery.queryKey });
  // A removal outlives its row, which leaves the list as soon as its address does, so what's left
  // undone, and trying again, stay on the page.
  const [unfinished, setUnfinished] = useState<{
    email: string;
    erase: boolean;
    problem: string;
  }>();
  const [isRetrying, setRetrying] = useState(false);
  const remove = async (email: string, erase: boolean) => {
    setUnfinished(undefined);
    try {
      await members.remove(email, erase);
    } catch (error) {
      setUnfinished({
        email,
        erase,
        problem: error instanceof Error ? error.message : String(error),
      });
    } finally {
      reload();
    }
  };
  const retry = async () => {
    if (!unfinished) return;
    setRetrying(true);
    await remove(unfinished.email, unfinished.erase);
    setRetrying(false);
  };

  return (
    <section aria-labelledby="members-title" {...stylex.props(styles.page)}>
      <h1 id="members-title" {...stylex.props(styles.title)}>
        Members
      </h1>
      <p {...stylex.props(styles.text)}>
        People you invite sign in with a code sent to their address, and each has a Trail Mix of
        their own, with mail nobody else here can see.
      </p>
      {error ? (
        <div role="alert">
          <Banner
            status="error"
            title="The member list couldn’t be read."
            description={error.message}
            endContent={<Button label="Try again" variant="ghost" onClick={() => void refetch()} />}
          />
          <a
            href={DASHBOARD}
            target="_blank"
            rel="noopener noreferrer"
            {...stylex.props(styles.link)}
          >
            Open Access in the Cloudflare dashboard
          </a>
        </div>
      ) : null}
      {unfinished && (
        <div role="alert">
          <Banner
            status="error"
            title={`Removing ${unfinished.email} isn’t finished.`}
            description={unfinished.problem}
            endContent={
              <Button
                label="Try again"
                variant="ghost"
                isLoading={isRetrying}
                onClick={() => void retry()}
              />
            }
          />
        </div>
      )}
      <Invite onInvited={reload} />
      {data && (
        <>
          <ul aria-label="Members" {...stylex.props(styles.list)}>
            {data.members.map((member) => (
              <Row key={member.email} member={member} onRemove={remove} />
            ))}
          </ul>
          {data.alsoAdmitted.length > 0 && (
            <section aria-labelledby="also-admitted" {...stylex.props(styles.also)}>
              <h2 id="also-admitted" {...stylex.props(styles.heading)}>
                Also admitted
              </h2>
              <ul {...stylex.props(styles.plain)}>
                {data.alsoAdmitted.map((said) => (
                  <li key={said}>{said}</li>
                ))}
              </ul>
              <p {...stylex.props(styles.quiet)}>
                Trail Mix doesn’t change these.{' '}
                <a
                  href={DASHBOARD}
                  target="_blank"
                  rel="noopener noreferrer"
                  {...stylex.props(styles.link)}
                >
                  Change them in the Cloudflare dashboard
                </a>
                .
              </p>
            </section>
          )}
        </>
      )}
    </section>
  );
}

/** Inviting someone: their address joins the list, and the page says what to send them. */
function Invite({ onInvited }: { onInvited: () => void }) {
  const [email, setEmail] = useState('');
  const [isBusy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string>();
  const [invited, setInvited] = useState<string>();
  const invite = async () => {
    setBusy(true);
    setProblem(undefined);
    try {
      await members.invite(email);
      setInvited(folded(email));
      setEmail('');
      onInvited();
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  const message = invited
    ? `Open ${location.origin} and sign in with ${invited}. You’ll get a code by email.`
    : '';
  return (
    <form
      aria-label="Invite someone"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void invite();
      }}
      {...stylex.props(styles.invite)}
    >
      <div {...stylex.props(styles.inviteRow)}>
        <TextInput
          label="Invite by email address"
          type="email"
          value={email}
          onChange={setEmail}
          hasSpellCheck={false}
          isDisabled={isBusy}
          controlXstyle={styles.control}
          {...(problem ? { status: { type: 'error', message: problem } } : {})}
        />
        <Button type="submit" label="Invite" variant="primary" isLoading={isBusy} />
      </div>
      {invited && (
        <div role="status" {...stylex.props(styles.sent)}>
          <p {...stylex.props(styles.text)}>
            {invited} can sign in now. Access sends nothing until they visit, so send them this:
          </p>
          <p {...stylex.props(styles.message)}>{message}</p>
          <Button
            label="Copy"
            variant="ghost"
            onClick={() => void navigator.clipboard.writeText(message)}
          />
        </div>
      )}
    </form>
  );
}

const WHEN = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

/** One member, and removing them, which asks first, inline, whether to erase too. */
function Row({
  member,
  onRemove,
}: {
  member: Member;
  onRemove: (email: string, erase: boolean) => Promise<void>;
}) {
  const [isAsking, setAsking] = useState(false);
  const [erase, setErase] = useState(true);
  const [isBusy, setBusy] = useState(false);
  const remove = async () => {
    setBusy(true);
    await onRemove(member.email, erase);
    setBusy(false);
    setAsking(false);
  };
  return (
    <li {...stylex.props(styles.row)}>
      <div {...stylex.props(styles.who)}>
        <strong {...stylex.props(styles.email)}>{member.email}</strong>
        <small {...stylex.props(styles.quiet)}>
          {member.operator ? 'You, the operator · ' : ''}
          {member.lastSeenAt
            ? `Last signed in ${WHEN.format(new Date(member.lastSeenAt))}`
            : 'Hasn’t signed in yet'}
        </small>
      </div>
      {!member.operator && !isAsking && (
        <Button label="Remove" variant="ghost" onClick={() => setAsking(true)} />
      )}
      {isAsking && (
        <div role="group" aria-label={`Remove ${member.email}`} {...stylex.props(styles.asking)}>
          <p {...stylex.props(styles.text)}>
            {member.email} comes off the list and is signed out at once, on every device.
          </p>
          <CheckboxInput
            label="Also erase what Trail Mix holds for them"
            description="Their accounts, passwords, index and the messages kept from opening them. Their mail stays on its servers."
            value={erase}
            onChange={setErase}
          />
          <div {...stylex.props(styles.actions)}>
            <Button
              label="Remove"
              variant="primary"
              isLoading={isBusy}
              onClick={() => void remove()}
            />
            <Button label="Cancel" variant="ghost" onClick={() => setAsking(false)} />
          </div>
        </div>
      )}
    </li>
  );
}

const styles = stylex.create({
  // Astryx draws a field at a fixed height, which a finger needs at 44px.
  control: {
    height: tm.target,
  },
  page: {
    display: 'flex',
    flexDirection: 'column',
    gap: spacingVars['--spacing-4'],
    width: '100%',
    maxWidth: tm.measure,
    paddingInline: {
      default: spacingVars['--spacing-6'],
      [media.phone]: spacingVars['--spacing-3'],
    },
    paddingBottom: spacingVars['--spacing-6'],
  },
  title: {
    margin: 0,
    fontFamily: tm.serif,
    fontSize: typeScaleVars['--text-heading-1-size'],
    fontWeight: typeScaleVars['--text-heading-1-weight'],
    lineHeight: typeScaleVars['--text-heading-1-leading'],
  },
  heading: {
    margin: 0,
    fontSize: typeScaleVars['--text-heading-3-size'],
    fontWeight: typeScaleVars['--text-heading-3-weight'],
  },
  text: {
    margin: 0,
  },
  quiet: {
    margin: 0,
    color: tm.textQuiet,
    fontSize: typeScaleVars['--text-supporting-size'],
  },
  link: {
    color: colorVars['--color-text-accent'],
  },
  invite: {
    display: 'flex',
    flexDirection: 'column',
    gap: spacingVars['--spacing-2'],
    margin: 0,
  },
  inviteRow: {
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 1fr) auto',
    alignItems: 'end',
    gap: spacingVars['--spacing-2'],
  },
  sent: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-start',
    gap: spacingVars['--spacing-2'],
    padding: spacingVars['--spacing-3'],
    borderRadius: tm.sheetRadius,
    backgroundColor: colorVars['--color-background-muted'],
  },
  message: {
    margin: 0,
    fontWeight: fontWeightVars['--font-weight-medium'],
    overflowWrap: 'anywhere',
  },
  list: {
    display: 'flex',
    flexDirection: 'column',
    margin: 0,
    padding: 0,
    listStyle: 'none',
    borderRadius: tm.sheetRadius,
    boxShadow: tm.sheetEdge,
    backgroundColor: colorVars['--color-background-card'],
  },
  row: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: spacingVars['--spacing-2'],
    paddingBlock: spacingVars['--spacing-2'],
    paddingInline: spacingVars['--spacing-3'],
    borderTopWidth: { default: borderVars['--border-width'], ':first-child': 0 },
    borderTopStyle: 'solid',
    borderTopColor: colorVars['--color-border'],
  },
  who: {
    display: 'flex',
    flexDirection: 'column',
    flexGrow: 1,
    minWidth: 0,
  },
  email: {
    overflowWrap: 'anywhere',
    fontWeight: fontWeightVars['--font-weight-semibold'],
  },
  asking: {
    display: 'flex',
    flexDirection: 'column',
    gap: spacingVars['--spacing-2'],
    flexBasis: '100%',
    padding: spacingVars['--spacing-3'],
    borderRadius: radiusVars['--radius-element'],
    backgroundColor: colorVars['--color-background-muted'],
  },
  actions: {
    display: 'flex',
    gap: spacingVars['--spacing-2'],
  },
  also: {
    display: 'flex',
    flexDirection: 'column',
    gap: spacingVars['--spacing-1'],
  },
  plain: {
    margin: 0,
    paddingInlineStart: spacingVars['--spacing-4'],
  },
});
