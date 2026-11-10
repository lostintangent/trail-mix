import { useCallback, useLayoutEffect, useState } from 'react';
import { deviceStorage } from '../../../shared/deviceStorage.ts';
import { panelSize, readPanel, savePanel, type PanelSpec, type PanelState } from './panels.ts';

/**
 * A side panel's state on this device, kept in storage and on its custom property on `<html>`,
 * where the prepaint script put it before first paint.
 */
export function usePanel(spec: PanelSpec): [PanelState, (state: PanelState) => void] {
  const [state, setState] = useState(() => readPanel(spec, deviceStorage()));

  useLayoutEffect(() => {
    document.documentElement.style.setProperty(spec.variable, `${panelSize(spec, state)}px`);
  }, [spec, state]);

  const change = useCallback(
    (next: PanelState) => {
      setState(next);
      savePanel(spec, next, deviceStorage());
    },
    [spec],
  );
  return [state, change];
}
