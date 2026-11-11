import { FieldLabel } from '@astryxdesign/core/Field';
import { Switch } from '@astryxdesign/core/Switch';
import {
  borderVars,
  colorVars,
  spacingVars,
  typeScaleVars,
} from '@astryxdesign/core/theme/tokens.stylex';
import * as stylex from '@stylexjs/stylex';
import { useQuery } from '@tanstack/react-query';
import { Suspense, useEffect, useId, useRef, type ReactNode } from 'react';
import { MembersSettings, operatorQuery, preloadMembers } from '../features/members/index.ts';
import { needsOf, type Notifications } from '../features/notifications/index.ts';
import type { SettingsAt } from '../features/workbench/index.ts';
import { AccentChoice, openAccentPicker } from './theme/AccentChoice.tsx';
import { TextSkeleton } from './theme/Pending.tsx';
import { media, tm } from './theme/tokens.stylex.ts';

/**
 * Settings, on the reader's sheet, as the gear at the foot of the sidebar opens it: notifications
 * for this device, where the deployment has them, the accent, and, for the operator alone, Members.
 * It gathers what each feature offers onto one page, and loads apart from the first screen. Opened
 * at a section, it brings that section into view, and opened at the accent it opens the picker too.
 */
export function Settings({
  at,
  notifications,
  accent,
  onAccent,
}: {
  at: SettingsAt | undefined;
  notifications: Notifications;
  accent: string | undefined;
  onAccent: (color: string | undefined) => void;
}) {
  const titleId = useId();
  const accentId = useId();
  const isOperator = useQuery(operatorQuery).data === true;
  useEffect(() => {
    if (isOperator) void preloadMembers();
  }, [isOperator]);
  const sections = useRef(new Map<SettingsAt, HTMLElement>());
  const place = (name: SettingsAt) => (element: HTMLElement | null) => {
    if (element) sections.current.set(name, element);
    else sections.current.delete(name);
  };
  useEffect(() => {
    if (!at) return;
    sections.current.get(at)?.scrollIntoView({ block: 'start' });
    if (at === 'accent') openAccentPicker();
  }, [at, isOperator]);

  return (
    <section aria-labelledby={titleId} {...stylex.props(styles.page)}>
      <h1 id={titleId} {...stylex.props(styles.title)}>
        Settings
      </h1>
      {notifications.isShown && (
        <Section title="Notifications" place={place('notifications')}>
          <Switch
            label="Notifications on this device"
            description={
              notifications.standing === 'able'
                ? 'New mail in your Inboxes shows here, even while Trail Mix is closed.'
                : needsOf(notifications.standing)
            }
            labelPosition="start"
            labelSpacing="spread"
            value={notifications.isOn}
            isDisabled={notifications.standing !== 'able'}
            isLoading={notifications.isBusy}
            onChange={() => void notifications.toggle()}
          />
        </Section>
      )}
      <Section title="Appearance" place={place('accent')}>
        <div {...stylex.props(styles.setting)}>
          <FieldLabel
            label="Accent color"
            inputID={accentId}
            description="Unread marks, links, focus rings and the main button take it, made readable in light and dark, which follow your system."
            descriptionID={`${accentId}-about`}
          />
          <div {...stylex.props(styles.controls)}>
            <AccentChoice
              accent={accent}
              onChange={onAccent}
              id={accentId}
              describedBy={`${accentId}-about`}
            />
          </div>
        </div>
      </Section>
      {isOperator && (
        <Section title="Members" place={place('members')}>
          <Suspense
            fallback={
              <div {...stylex.props(styles.pending)}>
                <TextSkeleton width="90%" />
                <TextSkeleton width="60%" />
              </div>
            }
          >
            <MembersSettings />
          </Suspense>
        </Section>
      )}
    </section>
  );
}

/** One section of Settings, under its heading, ruled off from the one above it. */
function Section({
  title,
  place,
  children,
}: {
  title: string;
  place: (element: HTMLElement | null) => void;
  children: ReactNode;
}) {
  const headingId = useId();
  return (
    <section ref={place} aria-labelledby={headingId} {...stylex.props(styles.section)}>
      <h2 id={headingId} {...stylex.props(styles.heading)}>
        {title}
      </h2>
      {children}
    </section>
  );
}

const styles = stylex.create({
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
  section: {
    display: 'flex',
    flexDirection: 'column',
    gap: spacingVars['--spacing-3'],
    paddingTop: spacingVars['--spacing-4'],
    borderTopWidth: borderVars['--border-width'],
    borderTopStyle: 'solid',
    borderTopColor: colorVars['--color-border'],
    // Brought into view, a section stands clear of the sheet's top edge.
    scrollMarginTop: spacingVars['--spacing-4'],
  },
  heading: {
    margin: 0,
    fontSize: typeScaleVars['--text-heading-3-size'],
    fontWeight: typeScaleVars['--text-heading-3-weight'],
  },
  // A setting's row, in the shape of a switch's spread out: its label and what it does on the left,
  // its control on the right.
  setting: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacingVars['--spacing-2'],
  },
  controls: {
    display: 'flex',
    alignItems: 'center',
    flexShrink: 0,
    gap: spacingVars['--spacing-1'],
  },
  pending: {
    display: 'flex',
    flexDirection: 'column',
    gap: spacingVars['--spacing-2'],
  },
});
