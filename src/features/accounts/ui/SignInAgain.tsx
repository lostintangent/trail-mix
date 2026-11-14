import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { spacingVars } from '@astryxdesign/core/theme/tokens.stylex';
import * as stylex from '@stylexjs/stylex';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Account } from '../../mail/core/index.ts';
import { mailroom, signInsQuery, type SignIn } from '../../mailroom/client/index.ts';
import { PRESETS, type Preset } from '../../providers/imap/core/index.ts';
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
  const [isBusy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string>();

  const begin = useCallback(async () => {
    setBusy(true);
    setRefusal(undefined);
    try {
      const started = await mailroom.signIn(account.id);
      queryClient.setQueryData(signInsQuery.queryKey, (held = []) => [
        ...held.filter(({ address }) => address !== started.address),
        started,
      ]);
      setSigningIn(started);
    } catch (error) {
      setRefusal(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }, [account.id, queryClient]);

  const started = useRef(false);
  useEffect(() => {
    if (!isStarting || started.current) return;
    started.current = true;
    void begin();
  }, [isStarting, begin]);

  if (signingIn) {
    return (
      <SignInStep
        key={signingIn.code}
        started={signingIn}
        vendor={vendor}
        onFinished={() => setSigningIn(undefined)}
        onAgain={() => void begin()}
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
      {refusal && (
        <div role="alert">
          <Banner status="error" title="The sign-in didn’t start." description={refusal} />
        </div>
      )}
      <div>
        <Button
          label="Sign in again"
          variant="primary"
          isLoading={isBusy}
          onClick={() => void begin()}
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
