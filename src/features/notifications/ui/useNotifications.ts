import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell, BellOff } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Command } from '../../commands/index.ts';
import { notifiedQuery } from '../../mailroom/client/index.ts';
import { standingOf, subscribedAt } from './device.ts';

/** The one command that turns this device's notifications on and off, and its bell's id. */
export const NOTIFICATIONS = 'notifications.toggle';

/** Turning notifications on and off, which the first screen goes without. */
const loadSetup = () => import('./setup.ts');
type Setup = Awaited<ReturnType<typeof loadSetup>>;

/**
 * Notifications on this device, as a command: on or off where the deployment has them, the palette
 * and the bell both drawing from it. Turning them on asks the browser's leave from the tap itself,
 * subscribes and tells the Mailroom, and turning them off does the reverse. Where the device can't
 * subscribe yet, it says what it needs. What turning does loads once the command shows, before
 * anyone can tap it, so the tap asks the browser at once.
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
  const isShown = Boolean(pushKey) && standing !== 'unable';
  const [setup, setSetup] = useState<Setup>();
  useEffect(() => {
    if (isShown) void loadSetup().then(setSetup);
  }, [isShown]);

  // A subscription made or ended may change the endpoint asked about, and the Mailroom's answer.
  const subscribed = endpoint.data ?? undefined;
  const settle = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: ['push-subscription'] });
    await queryClient.invalidateQueries({ queryKey: notifiedQuery(subscribed).queryKey });
  }, [queryClient, subscribed]);

  const toggle = useCallback(async () => {
    // Already loaded, as it is by any tap, so asking the browser comes from the tap itself.
    const turning = setup ?? (await loadSetup());
    if (standing !== 'able') return turning.sayWhatIsNeeded(standing);
    if (!pushKey) return;
    setBusy(true);
    try {
      if ((await turning.turn(isOn, pushKey)) === 'blocked') setStanding('blocked');
    } finally {
      await settle();
      setBusy(false);
    }
  }, [setup, standing, pushKey, isOn, settle]);

  return useMemo(() => {
    // Only a deployment with a push key notifies, and only a browser with Web Push can be.
    if (!isShown) return [];
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
  }, [isShown, isOn, isBusy, toggle]);
}
