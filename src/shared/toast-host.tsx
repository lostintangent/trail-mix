import { Button } from '@astryxdesign/core/Button';
import { ToastViewport, useToast, type ToastViewportProps } from '@astryxdesign/core/Toast';
import { useCallback, useEffect } from 'react';
import type { Show } from './toasts.tsx';

/**
 * Astryx's toast viewport, which hands the way to show a toast to `toast` once it's mounted. A
 * toast's action becomes a button at its end, which dismisses the toast as it acts.
 */
export default function ToastHost({
  layerInset,
  onReady,
}: Pick<ToastViewportProps, 'layerInset'> & { onReady: (show: Show) => void }) {
  const showToast = useToast();
  const show = useCallback<Show>(
    ({ body, type, action }) => {
      const dismiss = showToast({
        body,
        type,
        endContent: action && (
          <Button
            label={action.label}
            variant="ghost"
            size="sm"
            onClick={() => {
              dismiss();
              action.onAction();
            }}
          />
        ),
      });
      return dismiss;
    },
    [showToast],
  );
  useEffect(() => onReady(show), [show, onReady]);
  return <ToastViewport layerInset={layerInset} />;
}
