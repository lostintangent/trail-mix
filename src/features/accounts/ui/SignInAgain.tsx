import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { spacingVars } from '@astryxdesign/core/theme/tokens.stylex';
import * as stylex from '@stylexjs/stylex';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import type { Account } from '../../mail/core/index.ts';
import { mailroom, signInsQuery, type SignIn } from '../../mailroom/client/index.ts';
import { PRESETS, type Preset } from '../../providers/imap/core/index.ts';
import { reasonOf } from '../../../shared/reasons.ts';
import { Refusal } from './Refusal.tsx';
import { SignInStep } from './SignInStep.tsx';

/** Who an account signs in at, if it signs in at its vendor instead of with a password. */
export function vendorOf(account: Account): string | undefined {
  const preset: Preset | undefined = account.preset && PRESETS[account.preset];
  return preset?.device?.vendor;
}

/**
 * An account whose vendor wants its member to sign in again, as after 90 days unused: what that
 * means, and the sign-in that fixes it. Until then, Trail Mix can't check or send the account's
 * mail. Once the account is signed in again, the page that holds this stops showing it.
 */
export function SignInAgain({
  account,
  vendor,
  isStarting,
}: {
  account: Account;
  vendor: string;
  /** Starts the sign-in at once, as the palette's command and the Outbox ask. */
  isStarting: boolean | undefined;
}) {
  const queryClient = useQueryClient();
  const [signingIn, setSigningIn] = useState<SignIn>();
  const {
    mutate: begin,
    isPending,
    error,
  } = useMutation({
    mutationFn: () => mailroom.signIn(account.id),
    // Offline it fails at once and says so, rather than waiting with its button spinning.
    networkMode: 'always',
    onSuccess: (started) => {
      queryClient.setQueryData(signInsQuery.queryKey, (held = []) => [
        ...held.filter(({ address }) => address !== started.address),
        started,
      ]);
      setSigningIn(started);
    },
  });

  const started = useRef(false);
  useEffect(() => {
    if (!isStarting || started.current) return;
    started.current = true;
    begin();
  }, [isStarting, begin]);

  if (signingIn) {
    return (
      <SignInStep
        key={signingIn.code}
        started={signingIn}
        vendor={vendor}
        onFinished={() => setSigningIn(undefined)}
        onAgain={() => begin()}
        onBack={() => setSigningIn(undefined)}
      />
    );
  }
  return (
    <div {...stylex.props(styles.again)}>
      <Banner
        status="warning"
        title={`Sign in to ${account.name} again`}
        description={`${vendor} wants you to sign in again. Until you do, Trail Mix can’t check or send ${account.address}’s mail.`}
      />
      <Refusal title="The sign-in didn’t start." reason={error ? reasonOf(error) : undefined} />
      <div>
        <Button
          label="Sign in again"
          variant="primary"
          isLoading={isPending}
          onClick={() => begin()}
        />
      </div>
    </div>
  );
}

const styles = stylex.create({
  again: {
    display: 'flex',
    flexDirection: 'column',
    gap: spacingVars['--spacing-3'],
  },
});
