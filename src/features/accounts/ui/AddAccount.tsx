import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { SegmentedControl, SegmentedControlItem } from '@astryxdesign/core/SegmentedControl';
import { TextInput } from '@astryxdesign/core/TextInput';
import { fontWeightVars, spacingVars, typeScaleVars } from '@astryxdesign/core/theme/tokens.stylex';
import * as stylex from '@stylexjs/stylex';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useState } from 'react';
import { media, tm } from '../../../app/theme/tokens.stylex.ts';
import type { Account } from '../../mail/core/index.ts';
import {
  accountsQuery,
  mailroom,
  signInPresetsQuery,
  signInsQuery,
  type SignIn,
} from '../../mailroom/client/index.ts';
import { PRESETS } from '../../providers/imap/core/index.ts';
import {
  formFor,
  formProblems,
  nameFor,
  setupFrom,
  signInSetupFrom,
  type AccountForm,
  type PresetServers,
} from '../core/form.ts';
import { DEMO_SAID, isDemoOnly, signInNotSetUp } from '../core/said.ts';
import { SignInStep } from './SignInStep.tsx';

const ZOHO: PresetServers = PRESETS.zoho;
const MICROSOFT = PRESETS.outlook.device.vendor;

/**
 * Adding an account: Zoho, with its server names filled in to change, Outlook, whose member signs
 * in at Microsoft with a code, or any IMAP and SMTP host by its names and ports. The Mailroom tries
 * the password, or the token Microsoft gives, with the hosts before it keeps anything, and a refusal
 * shows in the host's own words.
 *
 * The password lives only in this form's state. It goes to the Mailroom once, in `addAccount`,
 * called directly rather than through a mutation, whose cache would keep it as a variable.
 */
export function AddAccount({
  accounts,
  onAdded,
  onCancel,
}: {
  accounts: readonly Account[];
  /** Told once the account is added, which the accounts snapshot already shows. */
  onAdded?: (account: Account) => void;
  /** Goes back without adding, where there is somewhere to go back to. */
  onCancel?: () => void;
}) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState(() => formFor('zoho', ZOHO));
  const [hasTried, setTried] = useState(false);
  const [checking, setChecking] = useState<string>();
  const [refusal, setRefusal] = useState<string>();
  const isDemo = isDemoOnly(accounts);
  const problems = formProblems(form, accounts);
  const shown = hasTried ? problems : {};
  const isBusy = checking !== undefined;
  const { data: signInPresets } = useQuery(signInPresetsQuery);
  const isOutlook = form.server === 'outlook';
  const canSignIn = !isOutlook || !signInPresets || signInPresets.includes('outlook');
  const [signingIn, setSigningIn] = useState<SignIn>();

  const added = useCallback(
    (account: Account) => {
      queryClient.setQueryData(accountsQuery.queryKey, (held = []) =>
        held.some(({ id }) => id === account.id) ? held : [...held, account],
      );
      // Every view, folder and count changes with an account, and the hint socket may not be open.
      void queryClient.invalidateQueries({ predicate: ({ queryKey }) => queryKey[0] !== 'body' });
      onAdded?.(account);
    },
    [queryClient, onAdded],
  );

  const add = async () => {
    setTried(true);
    if (Object.keys(problems).length > 0 || isBusy || isDemo || !canSignIn) return;
    setRefusal(undefined);
    setChecking(isOutlook ? MICROSOFT : form.imapHost.trim());
    try {
      if (isOutlook) {
        const started = await mailroom.signIn(signInSetupFrom(form));
        // The list shows it at once, before the hint that it started arrives.
        queryClient.setQueryData(signInsQuery.queryKey, (held = []) => [
          ...held.filter(({ address }) => address !== started.address),
          started,
        ]);
        setSigningIn(started);
      } else {
        added(await mailroom.addAccount(setupFrom(form, ZOHO)));
      }
    } catch (error) {
      setRefusal(error instanceof Error ? error.message : String(error));
    } finally {
      setChecking(undefined);
    }
  };

  if (signingIn) {
    return (
      <SignInStep
        key={signingIn.code}
        started={signingIn}
        vendor={MICROSOFT}
        onFinished={added}
        onAgain={() => void add()}
        onBack={() => setSigningIn(undefined)}
      />
    );
  }

  const field = (key: keyof AccountForm) => ({
    value: form[key],
    onChange: (value: string) => setForm((held) => ({ ...held, [key]: value })),
    isDisabled: isBusy,
    hasSpellCheck: false,
    controlXstyle: styles.control,
    ...(shown[key] ? { status: { type: 'error' as const, message: shown[key] } } : {}),
  });

  return (
    <form
      aria-label="Add an account"
      method="post"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void add();
      }}
      {...stylex.props(styles.form)}
    >
      {isDemo && <Banner status="info" title={DEMO_SAID} />}
      <SegmentedControl
        label="Mail host"
        value={form.server}
        onChange={(server) =>
          setForm((held) =>
            formFor(server === 'zoho' || server === 'outlook' ? server : 'other', ZOHO, held),
          )
        }
        isDisabled={isBusy}
      >
        <SegmentedControlItem value="zoho" label="Zoho" xstyle={styles.control} />
        <SegmentedControlItem value="outlook" label="Outlook" xstyle={styles.control} />
        <SegmentedControlItem value="other" label="Another IMAP host" xstyle={styles.control} />
      </SegmentedControl>

      <TextInput
        label="Address"
        type="email"
        autoComplete="username"
        placeholder="you@example.com"
        {...field('address')}
      />
      {!isOutlook && (
        <TextInput
          label="Password"
          type="password"
          autoComplete="off"
          description={
            form.server === 'zoho'
              ? 'An app password, which Zoho makes under My Account, Security, App Passwords.'
              : 'Your password, or an app password if your host asks for one.'
          }
          {...field('password')}
        />
      )}
      <TextInput
        label="Name"
        isOptional
        placeholder={nameFor({ name: '', address: form.address }) || undefined}
        description="What the sidebar calls this account."
        {...field('name')}
      />
      <TextInput
        label="From name"
        isOptional
        autoComplete="name"
        description="Who people see your mail is from, beside your address."
        {...field('fromName')}
      />

      {isOutlook && !canSignIn && (
        <Banner status="info" title={signInNotSetUp(MICROSOFT, 'MICROSOFT_CLIENT_ID')} />
      )}
      {isOutlook && canSignIn && (
        <p {...stylex.props(styles.quiet)}>
          You sign in at Microsoft with a code, so Trail Mix never sees your password.
        </p>
      )}

      {!isOutlook && (
        <fieldset {...stylex.props(styles.servers)}>
          <legend {...stylex.props(styles.legend)}>Servers</legend>
          <p {...stylex.props(styles.quiet)}>
            {form.server === 'zoho'
              ? 'Use the server names Zoho Mail lists for your account, under Settings, Mail Accounts.'
              : 'Ports 993 and 465 use TLS from the start, and 143 and 587 use STARTTLS.'}
          </p>
          <div {...stylex.props(form.server === 'other' && styles.pair)}>
            <TextInput label="IMAP server" {...field('imapHost')} />
            {form.server === 'other' && <TextInput label="IMAP port" {...field('imapPort')} />}
          </div>
          <div {...stylex.props(form.server === 'other' && styles.pair)}>
            <TextInput label="SMTP server" {...field('smtpHost')} />
            {form.server === 'other' && <TextInput label="SMTP port" {...field('smtpPort')} />}
          </div>
        </fieldset>
      )}

      {refusal && (
        <div role="alert">
          <Banner status="error" title="The account wasn’t added." description={refusal} />
        </div>
      )}
      <div {...stylex.props(styles.actions)}>
        <Button
          type="submit"
          variant="primary"
          label={
            isBusy
              ? `${isOutlook ? 'Asking' : 'Checking with'} ${checking}…`
              : isOutlook
                ? `Sign in with ${MICROSOFT}`
                : 'Add account'
          }
          isLoading={isBusy}
          isDisabled={isDemo || !canSignIn}
        />
        {onCancel && <Button label="Cancel" variant="ghost" onClick={onCancel} />}
      </div>
      {isBusy && !isOutlook && (
        <p role="status" {...stylex.props(styles.quiet)}>
          Signing in to {form.imapHost.trim()}, then {form.smtpHost.trim()}. A host that doesn’t
          answer can take half a minute.
        </p>
      )}
    </form>
  );
}

const styles = stylex.create({
  // Astryx draws a field and a segmented choice at a fixed height, which a finger needs at 44px.
  control: {
    height: tm.target,
  },
  form: {
    display: 'flex',
    flexDirection: 'column',
    gap: spacingVars['--spacing-4'],
    margin: 0,
  },
  servers: {
    display: 'flex',
    flexDirection: 'column',
    gap: spacingVars['--spacing-3'],
    minWidth: 0,
    margin: 0,
    padding: 0,
    borderWidth: 0,
  },
  legend: {
    padding: 0,
    marginBottom: spacingVars['--spacing-1'],
    fontWeight: fontWeightVars['--font-weight-semibold'],
  },
  quiet: {
    margin: 0,
    color: tm.textQuiet,
    fontSize: typeScaleVars['--text-supporting-size'],
  },
  // A server's name, and beside it its port, which goes under it on a phone.
  pair: {
    display: 'grid',
    gridTemplateColumns: {
      default: 'minmax(0, 3fr) minmax(0, 1fr)',
      [media.phone]: 'minmax(0, 1fr)',
    },
    gap: spacingVars['--spacing-3'],
  },
  actions: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: spacingVars['--spacing-2'],
  },
});
