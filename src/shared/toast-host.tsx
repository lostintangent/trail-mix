import { ToastViewport, useToast, type ToastViewportProps } from '@astryxdesign/core/Toast';
import { useEffect } from 'react';

/** Astryx's toast viewport, which hands the way to show a toast to `toast` once it's mounted. */
export default function ToastHost({
  layerInset,
  onReady,
}: Pick<ToastViewportProps, 'layerInset'> & {
  onReady: (show: ReturnType<typeof useToast>) => void;
}) {
  const show = useToast();
  useEffect(() => onReady(show), [show, onReady]);
  return <ToastViewport layerInset={layerInset} />;
}
