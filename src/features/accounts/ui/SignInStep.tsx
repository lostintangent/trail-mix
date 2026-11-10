import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import {
  colorVars,
  fontWeightVars,
  spacingVars,
  typeScaleVars,
  typographyVars,
} from '@astryxdesign/core/theme/tokens.stylex';
import * as stylex from '@stylexjs/stylex';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { tm } from '../../../app/theme/tokens.stylex.ts';
import type { Account } from '../../mail/core/index.ts';
import { accountsQuery, signInsQuery, type SignIn } from '../../mailroom/client/index.ts';
import { EXPIRED } from '../../providers/imap/core/index.ts';

/**
 * A sign-in at a vendor while the member enters its code there: the code, the page to enter it at,
 * and how long it lasts. The Mailroom polls the vendor, so this shows only what the Mailroom says,
 * except that it calls the code expired once its time is up, before the Mailroom gets round to it.
 *
 * It's finished when its row is gone and the account is there, and no longer waiting to be signed in
 * again. A row gone with neither means the code expired.
 */
export function SignInStep({
  started,
  vendor,
  onFinished,
  onAgain,
  onBack,
}: {
  /** The sign-in as `signIn` returned it, which shows until the Mailroom's list has it. */
  started: SignIn;
  /** Who the member signs in at, such as Microsoft. */
  vendor: string;
  onFinished: (account: Account) => void;
  /** Starts another sign-in, with a new code. */
  onAgain: () => void;
  onBack: () => void;
}) {
  const { data: signIns } = useQuery(signInsQuery);
  const { data: accounts } = useQuery(accountsQuery);
  const now = useSecond();
  const address = started.address.toLowerCase();
  const row = signIns ? signIns.find((held) => held.address.toLowerCase() === address) : started;
  const account = accounts?.find((held) => held.address.toLowerCase() === address);
  const finished = !row && account && account.status !== 'needs-sign-in' ? account : undefined;
  const told = useRef(false);
  useEffect(() => {
    if (!finished || told.current) return;
    told.current = true;
    onFinished(finished);
  }, [finished, onFinished]);

  const shown = row ?? started;
  const left = Date.parse(shown.expiresAt) - now;
  const stopped = row?.state === 'refused' ? row.reason : !row || left <= 0 ? EXPIRED : undefined;
  const page = pageName(shown.link);

  if (finished) return null;
  if (stopped) {
    return (
      <section aria-label={`Signing in at ${vendor}`} {...stylex.props(styles.step)}>
        <div role="alert">
          <Banner status="error" title="The sign-in didn’t finish." description={stopped} />
        </div>
        <div {...stylex.props(styles.actions)}>
          <Button label="Get a new code" variant="primary" onClick={onAgain} />
          <Button label="Back" variant="ghost" onClick={onBack} />
        </div>
      </section>
    );
  }
  return (
    <section aria-label={`Signing in at ${vendor}`} {...stylex.props(styles.step)}>
      <p {...stylex.props(styles.text)}>
        Open {page}, enter this code, and sign in as{' '}
        <strong {...stylex.props(styles.address)}>{started.address}</strong>.
      </p>
      <div {...stylex.props(styles.card)}>
        <output aria-label="Code" {...stylex.props(styles.code)}>
          {shown.code}
        </output>
        <Button
          label="Copy"
          variant="secondary"
          onClick={() => void navigator.clipboard.writeText(shown.code)}
        />
      </div>
      <div {...stylex.props(styles.actions)}>
        <Button
          label={`Open ${page}`}
          variant="primary"
          href={shown.link}
          target="_blank"
          rel="noopener noreferrer"
        />
        <Button label="Cancel" variant="ghost" onClick={onBack} />
      </div>
      <p role="status" {...stylex.props(styles.quiet)}>
        {shown.state === 'checking'
          ? `Signed in at ${vendor}. Checking with the mail servers…`
          : `Waiting for you to sign in at ${vendor}…`}
      </p>
      <p {...stylex.props(styles.quiet)}>The code expires in {clock(left)}.</p>
    </section>
  );
}

/** The time now, moving on each second while it's shown. */
function useSecond(): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setTimeout(() => setNow(Date.now()), 1000 - (now % 1000));
    return () => clearTimeout(timer);
  }, [now]);
  return now;
}

/** Minutes and seconds, as a countdown reads. */
function clock(ms: number): string {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

/** A page as a member would type it: microsoft.com/link for https://www.microsoft.com/link. */
function pageName(link: string): string {
  const url = new URL(link);
  return `${url.host.replace(/^www\./, '')}${url.pathname === '/' ? '' : url.pathname}`;
}

const styles = stylex.create({
  step: {
    display: 'flex',
    flexDirection: 'column',
    gap: spacingVars['--spacing-3'],
  },
  text: {
    margin: 0,
  },
  address: {
    overflowWrap: 'anywhere',
    fontWeight: fontWeightVars['--font-weight-semibold'],
  },
  // The code on its own sheet, large enough to read across a room and copy with a tap.
  card: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacingVars['--spacing-3'],
    padding: spacingVars['--spacing-4'],
    borderRadius: tm.sheetRadius,
    boxShadow: tm.sheetEdge,
    backgroundColor: colorVars['--color-background-card'],
  },
  code: {
    fontFamily: typographyVars['--font-family-code'],
    fontSize: typeScaleVars['--text-heading-1-size'],
    fontWeight: fontWeightVars['--font-weight-semibold'],
    lineHeight: typeScaleVars['--text-heading-1-leading'],
    whiteSpace: 'nowrap',
    userSelect: 'all',
  },
  actions: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: spacingVars['--spacing-2'],
  },
  quiet: {
    margin: 0,
    color: tm.textQuiet,
    fontSize: typeScaleVars['--text-supporting-size'],
    fontVariantNumeric: 'tabular-nums',
  },
});
