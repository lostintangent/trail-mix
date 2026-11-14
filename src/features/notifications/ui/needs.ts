import type { Readiness } from './device.ts';

/**
 * What a device that can't subscribe yet needs first, as Settings and the palette's command say.
 * Only they say it, so the first screen goes without these words.
 */
export function needsOf(readiness: Exclude<Readiness, 'able'>): string {
  return NEEDS[readiness === 'unable' ? 'needs-install' : readiness];
}

const NEEDS = {
  'needs-install':
    'Notifications come to Trail Mix installed as an app. Install it from your browser, then turn them on there.',
  'needs-home-screen':
    'On iPhone, notifications come to Trail Mix on the Home Screen. Tap Share, then Add to Home Screen, and turn them on there.',
  blocked:
    'Notifications are blocked for Trail Mix in this browser’s settings. Allow them there, then turn them on here.',
} as const;
