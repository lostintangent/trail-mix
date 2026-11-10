import { colorVars, spacingVars, typeScaleVars } from '@astryxdesign/core/theme/tokens.stylex';
import * as stylex from '@stylexjs/stylex';
import { media, tm } from '../../../app/theme/tokens.stylex.ts';
import { AddAccount } from './AddAccount.tsx';

/**
 * What a member with no accounts sees: who can read what Trail Mix stores, said before anything is
 * stored, and the form that adds their first account. Adding it opens the workbench on its mail.
 */
export function FirstRun() {
  return (
    <main {...stylex.props(styles.desk)}>
      <article aria-labelledby="first-run-title" {...stylex.props(styles.sheet)}>
        <h1 id="first-run-title" {...stylex.props(styles.title)}>
          Welcome to Trail Mix
        </h1>
        <p {...stylex.props(styles.text)}>
          Add a mailbox to read and send its mail here. Your mail stays on its server, and Trail Mix
          keeps an index of it and the messages you open.
        </p>
        <section aria-labelledby="first-run-trust" {...stylex.props(styles.notice)}>
          <h2 id="first-run-trust" {...stylex.props(styles.heading)}>
            Who can read your mail
          </h2>
          <p {...stylex.props(styles.text)}>
            Trail Mix stores your account settings, your encrypted credentials and the messages
            waiting to be sent, all in the Cloudflare account it is deployed to. Whoever controls
            that Cloudflare account can read everything stored there, encryption included, because
            the key is theirs. If someone else runs Trail Mix for you, you are trusting them with
            your mail.
          </p>
        </section>
        <h2 {...stylex.props(styles.heading)}>Add an account</h2>
        <AddAccount accounts={[]} />
      </article>
    </main>
  );
}

const styles = stylex.create({
  desk: {
    minHeight: '100dvh',
    display: 'flex',
    justifyContent: 'center',
    alignItems: { default: 'flex-start', [media.phone]: 'stretch' },
    padding: { default: spacingVars['--spacing-8'], [media.phone]: 0 },
    backgroundColor: colorVars['--color-background-body'],
  },
  // A sheet of paper on the desk, which on a phone is the whole screen.
  sheet: {
    display: 'flex',
    flexDirection: 'column',
    gap: spacingVars['--spacing-4'],
    width: '100%',
    maxWidth: tm.measure,
    paddingBlock: {
      default: spacingVars['--spacing-6'],
      [media.phone]: `max(${tm.safeTop}, ${spacingVars['--spacing-6']})`,
    },
    paddingInline: {
      default: spacingVars['--spacing-6'],
      [media.phone]: spacingVars['--spacing-4'],
    },
    backgroundColor: colorVars['--color-background-surface'],
    color: colorVars['--color-text-primary'],
    borderRadius: { default: tm.paneRadius, [media.phone]: 0 },
    boxShadow: { default: tm.sheetEdge, [media.phone]: 'none' },
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
    lineHeight: typeScaleVars['--text-heading-3-leading'],
  },
  text: {
    margin: 0,
  },
  // The one thing to read before anything is stored, set apart on the desk's own shade.
  notice: {
    display: 'flex',
    flexDirection: 'column',
    gap: spacingVars['--spacing-2'],
    padding: spacingVars['--spacing-4'],
    borderRadius: tm.sheetRadius,
    backgroundColor: colorVars['--color-background-muted'],
  },
});
