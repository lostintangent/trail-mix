import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell, BellOff } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';
import type { Command } from '../../commands/index.ts';
import { mailroom, notifiedQuery } from '../../mailroom/client/index.ts';
import { toast } from '../../../shared/toasts.tsx';
import { NotAllowed, standingOf, subscribe, subscribedAt, unsubscribe } from './device.ts';

/** The one command that turns this device's notifications on and off, and its bell's id. */
export const NOTIFICATIONS = 'notifications.toggle';

/** What each standing short of subscribing says when the member asks for notifications. */
const NEEDS = {
  'needs-install':
    'Notifications come to Trail Mix installed as an app. Install it from your browser, then turn them on there.',
  'needs-home-screen':
    'On iPhone, notifications come to Trail Mix on the Home Screen. Tap Share, then Add to Home Screen, and turn them on there.',
  blocked:
    'Notifications are blocked for Trail Mix in this browser’s settings. Allow them there, then turn them on here.',
} as const;

/**
 * Notifications on this device, as a command: on or off where the deployment has them, the palette
 * and the bell both drawing from it. Turning them on asks the browser's leave from the tap itself,
 * subscribes and tells the Mailroom, and turning them off does the reverse. Where the device can't
 * subscribe yet, it says what it needs.
 */
export function useNotificationCommands(): Command[] {
  const queryClient = useQueryClient();
  const [standing, setStanding] = useState(standingOf);
  const [isBusy, setBusy] = useState(false);
  const endpoint = useQuery({
    queryKey: ['push-subscription'],
    queryFn: async () => (await subscribedAt()) ?? null,
    enabled: standing === 'able',
    staleTime: Infinity,
  });
  const asked = standing !== 'able' || endpoint.isSuccess;
  const device = useQuery({ ...notifiedQuery(endpoint.data ?? undefined), enabled: asked });
  const pushKey = device.data?.pushKey;
  const isOn = device.data?.notified === true;

  // A subscription made or ended may change the endpoint asked about, and the Mailroom's answer.
  const subscribed = endpoint.data ?? undefined;
  const settle = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: ['push-subscription'] });
    await queryClient.invalidateQueries({ queryKey: notifiedQuery(subscribed).queryKey });
  }, [queryClient, subscribed]);

  const toggle = useCallback(async () => {
    if (standing !== 'able') {
      void toast({ body: NEEDS[standing === 'unable' ? 'needs-install' : standing] });
      return;
    }
    if (!pushKey) return;
    setBusy(true);
    try {
      if (isOn) {
        const ended = await unsubscribe();
        if (ended) await mailroom.forgetDevice(ended);
      } else {
        await mailroom.notifyDevice(await subscribe(pushKey));
      }
    } catch (error) {
      if (error instanceof NotAllowed && error.answer === 'denied') setStanding('blocked');
      void toast({
        type: 'error',
        body: `Couldn’t turn notifications ${isOn ? 'off' : 'on'}. ${error instanceof Error ? error.message : String(error)}`,
      });
    } finally {
      await settle();
      setBusy(false);
    }
  }, [standing, pushKey, isOn, settle]);

  return useMemo(() => {
    // Only a deployment with a push key notifies, and only a browser with Web Push can be.
    if (!pushKey || standing === 'unable') return [];
    return [
      {
        id: NOTIFICATIONS,
        title: isOn
          ? 'Turn off notifications on this device'
          : 'Turn on notifications on this device',
        group: 'This device',
        icon: isOn ? Bell : BellOff,
        isChecked: isOn,
        isEnabled: !isBusy,
        run: toggle,
      },
    ];
  }, [pushKey, standing, isOn, isBusy, toggle]);
}
