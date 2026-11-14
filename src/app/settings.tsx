import { FieldLabel } from '@astryxdesign/core/Field';
import { Switch } from '@astryxdesign/core/Switch';
import {
  borderVars,
  colorVars,
  sizeVars,
  spacingVars,
  typeScaleVars,
} from '@astryxdesign/core/theme/tokens.stylex';
import * as stylex from '@stylexjs/stylex';
import { useEffect, useId, useRef, type ReactNode } from 'react';
import { needsOf, type Notifications } from '../features/notifications/index.ts';
import type { SettingsAt } from '../features/workbench/index.ts';
import { AccentChoice, openAccentPicker } from './theme/AccentChoice.tsx';
import { ReaderPage } from './theme/ReaderPage.tsx';
import { media, tm } from './theme/tokens.stylex.ts';

/**
 * Settings, on the reader's sheet, as the gear at the foot of the sidebar opens it: notifications
 * for this device, where the deployment has them, and the accent.
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
  const accentId = useId();
  const sections = useRef(new Map<SettingsAt, HTMLElement>());
  const place = (name: SettingsAt) => (element: HTMLElement | null) => {
    if (element) sections.current.set(name, element);
    else sections.current.delete(name);
  };
  useEffect(() => {
    if (!at) return;
    sections.current.get(at)?.scrollIntoView({ block: 'start' });
    if (at === 'accent') openAccentPicker();
  }, [at]);

  return (
    <ReaderPage title="Settings" xstyle={styles.page}>
      {notifications.isShown && (
        <Section title="Notifications" place={place('notifications')}>
          <Switch
            label="Notifications on this device"
            description={
              notifications.readiness === 'able'
                ? 'New mail in your Inboxes shows here, even while Trail Mix is closed.'
                : needsOf(notifications.readiness)
            }
            labelPosition="start"
            labelSpacing="spread"
            value={notifications.isOn}
            isDisabled={notifications.readiness !== 'able'}
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
    </ReaderPage>
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
    // A phone's gutter is narrower than a finger's target reaches past the swatch, so the target's
    // last few pixels lie past the screen's edge, where no finger can reach, and are cut off there
    // rather than letting the page slide sideways.
    overflowX: { default: null, [media.phone]: 'clip' },
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
  // A control draws less than its target: the swatch sits centered in a target the size of a
  // button. Its target reaches past it into the page's padding, so what it draws ends where a
  // switch's track does.
  controls: {
    display: 'flex',
    alignItems: 'center',
    flexShrink: 0,
    gap: spacingVars['--spacing-1'],
    marginInlineEnd: `calc((${tm.swatch} - ${sizeVars['--size-element-sm']}) / 2)`,
  },
});
