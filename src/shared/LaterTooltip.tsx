import type { TooltipOptions, TooltipProps, TooltipReturn } from '@astryxdesign/core/Tooltip';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
  type RefObject,
} from 'react';
import { afterFirstScreen } from './afterFirstScreen.ts';

/*
 * Tooltips that join their controls once their code arrives, apart from the first screen. A
 * tooltip shows only after a hover or a focus has rested on its control, so a control drawn first
 * and given its tooltip a moment later looks and reads the same: its name is its own, and only the
 * tooltip waits. The code loads once the first screen has settled, or at once when a pointer or
 * focus reaches a control, and a tooltip that arrives while a mouse or keyboard focus rests there
 * opens straight away. A tap or a press never opens one, as neither does once the code is in hand.
 */

/** A control's tooltip, beside it rather than wired into it. */
export function LaterTooltip({
  anchor,
  content,
  placement,
}: {
  /** The control the tooltip belongs to, which keeps its own accessible name. */
  anchor: RefObject<HTMLElement | null>;
  content: ReactNode;
  placement?: TooltipProps['placement'];
}) {
  const { tooltips, rests } = useArrival(anchor);
  if (!tooltips) return null;
  const { Tooltip } = tooltips;
  return (
    <Tooltip anchorRef={anchor} content={content} placement={placement} isDefaultOpen={rests()} />
  );
}

/** What Astryx's `Button` reads of its tooltip hook. */
export type ButtonTooltip = Pick<TooltipReturn, 'ref' | 'renderTooltip'> & {
  describedBy: string | undefined;
};

/**
 * Astryx's `useTooltip`, as `astryxButtonTooltip` gives it to Astryx's `Button`, so the first
 * screen's buttons take their tooltips later. A button drawn once the code is in hand runs the real
 * hook. One drawn before runs it in a child of its own once the code arrives, wired to the button,
 * which names the tooltip it describes from then on.
 */
export function useLaterTooltip(options: TooltipOptions = {}): ButtonTooltip {
  // Chosen as the button mounts, so it runs the same hooks for as long as it lives.
  const [useTooltip] = useState(() => tooltips?.useTooltip ?? useTooltipOnArrival);
  return useTooltip(options);
}

function useTooltipOnArrival(options: TooltipOptions): ButtonTooltip {
  const trigger = useRef<HTMLElement | null>(null);
  const [describedBy, describe] = useState<string>();
  const ref = useCallback((element: HTMLElement | null) => {
    trigger.current = element;
  }, []);
  return {
    ref,
    describedBy,
    renderTooltip: (content, props) => (
      <TooltipOnArrival
        trigger={trigger}
        options={options}
        content={content}
        props={props}
        describe={describe}
      />
    ),
  };
}

type Wiring = {
  trigger: RefObject<HTMLElement | null>;
  options: TooltipOptions;
  content: ReactNode;
  props: Parameters<TooltipReturn['renderTooltip']>[1];
  describe: (id: string) => void;
};

function TooltipOnArrival(wiring: Wiring) {
  const { tooltips, rests } = useArrival(wiring.trigger);
  if (!tooltips) return null;
  return <TooltipNow {...wiring} useTooltip={tooltips.useTooltip} opens={rests} />;
}

/** Astryx's own hook, wired to a button drawn before it came. */
function TooltipNow({
  trigger,
  options,
  content,
  props,
  describe,
  useTooltip,
  opens,
}: Wiring & { useTooltip: Tooltips['useTooltip']; opens: () => boolean }) {
  const [isDefaultOpen] = useState(opens);
  const tooltip = useTooltip({ ...options, isDefaultOpen });
  const wired = useRef<{ element: HTMLElement; ref: TooltipReturn['ref']; unwire: () => void }>(
    null,
  );
  // The button's element comes before its tooltip, so its ref is set by the time this runs.
  useLayoutEffect(() => {
    const element = trigger.current;
    if (wired.current?.element === element && wired.current.ref === tooltip.ref) return;
    wired.current?.unwire();
    wired.current = element && { element, ref: tooltip.ref, unwire: wire(tooltip.ref, element) };
  });
  useLayoutEffect(() => () => wired.current?.unwire(), []);
  useLayoutEffect(() => describe(tooltip.describedBy), [describe, tooltip.describedBy]);
  return tooltip.renderTooltip(content, props);
}

function wire(ref: TooltipReturn['ref'], element: HTMLElement): () => void {
  const unwire = ref(element);
  return typeof unwire === 'function' ? unwire : () => ref(null);
}

/**
 * The tooltips' code for a control, which asks for it once the first screen has settled or as soon
 * as a pointer or focus reaches the control, and whether a mouse or keyboard focus rests on the
 * control as it arrives. A press ends a mouse's rest, as it shuts a tooltip already open.
 */
function useArrival(anchor: RefObject<HTMLElement | null>) {
  const tooltips = useSyncExternalStore(subscribe, loaded);
  const [isWaiting] = useState(() => !tooltips);
  const isMouseResting = useRef(false);
  useEffect(() => {
    if (tooltips) return;
    const element = anchor.current;
    const want = () => void load();
    const enter = (event: PointerEvent) => {
      isMouseResting.current = event.pointerType === 'mouse';
      want();
    };
    const press = () => (isMouseResting.current = false);
    element?.addEventListener('pointerenter', enter);
    element?.addEventListener('pointerdown', press);
    element?.addEventListener('focusin', want);
    const callOff = afterFirstScreen(want);
    return () => {
      element?.removeEventListener('pointerenter', enter);
      element?.removeEventListener('pointerdown', press);
      element?.removeEventListener('focusin', want);
      callOff();
    };
  }, [anchor, tooltips]);
  const rests = () => {
    const element = anchor.current;
    if (!isWaiting || !element) return false;
    return (isMouseResting.current && element.matches(':hover')) || focusRests(element);
  };
  return { tooltips, rests };
}

/** Whether keyboard focus is on `element` or inside it, which a tap's focus never is. */
function focusRests(element: HTMLElement): boolean {
  const focused = element.ownerDocument.activeElement;
  return (
    focused instanceof HTMLElement && element.contains(focused) && focused.matches(':focus-visible')
  );
}

type Tooltips = typeof import('@astryxdesign/core/Tooltip');

let tooltips: Tooltips | undefined;
let loading: Promise<void> | undefined;
const listeners = new Set<() => void>();

const loaded = () => tooltips;

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

function load(): Promise<void> {
  loading ??= import('@astryxdesign/core/Tooltip').then(
    (module) => {
      tooltips = module;
      for (const listener of listeners) listener();
    },
    () => {
      // Without its code a control keeps no tooltip, and the next reach asks again.
      loading = undefined;
    },
  );
  return loading;
}
