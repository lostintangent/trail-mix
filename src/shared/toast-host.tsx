import { Button } from '@astryxdesign/core/Button';
import { Icon } from '@astryxdesign/core/Icon';
import { ToastViewport, useToast, type ToastViewportProps } from '@astryxdesign/core/Toast';
import { useCallback, useEffect } from 'react';
import { ToastRule } from './ToastRule.tsx';
import type { Show } from './toasts.tsx';

type Ready = { onReady: (show: Show) => void };

/**
 * Astryx's toast viewport, which hands the way to show a toast to `toast` once it's mounted. The
 * viewport provides the toasts its children show, so they render in the app's own tree, with its
 * contexts and the viewport's inset. Outside it, Astryx would mount a detached viewport of its own.
 */
export default function ToastHost({
  layerInset,
  onReady,
}: Pick<ToastViewportProps, 'layerInset'> & Ready) {
  return (
    <ToastViewport layerInset={layerInset}>
      <Shows onReady={onReady} />
    </ToastViewport>
  );
}

/**
 * Shows a toast in the viewport above it. Its action becomes a button at its end, ruled off from
 * the close, which dismisses the toast as it acts, and a toast that draws itself is Astryx's custom
 * content.
 */
function Shows({ onReady }: Ready) {
  const showToast = useToast();
  const show = useCallback<Show>(
    ({ body, type, action, render, onHide }) => {
      const dismiss = showToast({
        body,
        type,
        ...(onHide && { onHide: () => onHide() }),
        ...(render && { renderContent: ({ dismiss }) => render(dismiss), isAutoHide: false }),
        endContent: action && (
          <>
            <Button
              label={action.label}
              {...(action.icon && {
                icon: <Icon icon={action.icon} size="sm" color="inherit" />,
                isIconOnly: true,
                tooltip: action.tooltip ?? action.label,
              })}
              variant="ghost"
              size="sm"
              onClick={() => {
                dismiss();
                action.onAction();
              }}
            />
            <ToastRule />
          </>
        ),
      });
      return dismiss;
    },
    [showToast],
  );
  useEffect(() => onReady(show), [show, onReady]);
  return null;
}
