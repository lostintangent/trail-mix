import { Icon } from '@astryxdesign/core/Icon';
import {
  colorVars,
  fontWeightVars,
  radiusVars,
  spacingVars,
  typographyVars,
} from '@astryxdesign/core/theme/tokens.stylex';
import * as stylex from '@stylexjs/stylex';
import {
  CircleCheck,
  CircleDashed,
  CircleDot,
  CircleSlash,
  CircleX,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  MessagesSquare,
  type LucideIcon,
} from 'lucide-react';
import { useLayoutEffect, useRef } from 'react';
import { media, tm } from '../../../app/theme/tokens.stylex.ts';
import type { BundleChip, GitHubThread } from '../../mail/core/index.ts';
import { chipFactOf, type Fact } from '../core/github.ts';

/** A thread's kind as GitHub draws it, by what became of it. */
export function kindIconOf({
  kind,
  state,
  outcome,
}: Pick<GitHubThread, 'kind' | 'state' | 'outcome'>): LucideIcon {
  switch (kind) {
    case 'pull':
      return state === 'merged'
        ? GitMerge
        : state === 'closed'
          ? GitPullRequestClosed
          : GitPullRequest;
    case 'issue':
      return CircleDot;
    case 'discussion':
      return MessagesSquare;
    case 'run':
      return outcome === 'failed'
        ? CircleX
        : outcome === 'passed'
          ? CircleCheck
          : outcome === 'cancelled'
            ? CircleSlash
            : CircleDashed;
  }
}

/**
 * One fact about a GitHub thread, as a small pill. One that asks something of the member is set in
 * ink on a plate, the rest in quieter ink in a ring. Ink alone ranks them, never the accent or the
 * highlighter, which mean other things.
 */
export function Chip({ fact, icon }: { fact: Fact; icon?: LucideIcon }) {
  return (
    <span {...stylex.props(styles.chip, fact.asks && styles.asks)}>
      {icon && <Icon icon={icon} size="xsm" xstyle={styles.icon} />}
      {fact.label}
    </span>
  );
}

/**
 * A bundle's chips on its row's last line, one for each of its first threads, as many as fit. Those
 * that don't, and the threads past the first chips, fold into +N at the line's end. The line is
 * measured as it is drawn and whenever its width changes, and chips are shown and hidden in place,
 * so a fold never draws the row twice.
 */
export function BundleChips({ chips, threads }: { chips: readonly BundleChip[]; threads: number }) {
  const line = useRef<HTMLSpanElement>(null);
  const beyond = threads - chips.length;
  useLayoutEffect(() => {
    const element = line.current;
    if (!element) return;
    fold(element, beyond);
    const observer = new ResizeObserver(() => fold(element, beyond));
    observer.observe(element);
    return () => observer.disconnect();
  }, [chips, beyond]);
  return (
    <span ref={line} {...stylex.props(styles.chips)}>
      {chips.map((chip, at) => (
        <Chip key={at} fact={chipFactOf(chip)} icon={kindIconOf(chip)} />
      ))}
      <span {...stylex.props(styles.chip)} />
    </span>
  );
}

/** Shows as many of a line's chips as fit beside its +N, which counts the rest and `beyond`. */
function fold(line: HTMLElement, beyond: number) {
  const chips = [...line.children] as HTMLElement[];
  const more = chips.pop();
  if (!more) return;
  for (const chip of chips) chip.style.display = '';
  more.style.display = '';
  const gap = parseFloat(getComputedStyle(line).columnGap) || 0;
  const room = line.clientWidth;
  const widths = chips.map((chip) => chip.offsetWidth);
  const span = (count: number) =>
    widths.slice(0, count).reduce((sum, width) => sum + width, 0) + gap * Math.max(0, count - 1);
  const fits = (count: number) => {
    const folded = chips.length - count + beyond;
    if (folded === 0) return span(count) <= room;
    more.textContent = `+${folded}`;
    return span(count) + (count > 0 ? gap : 0) + more.offsetWidth <= room;
  };
  let shown = chips.length;
  while (shown > 0 && !fits(shown)) shown--;
  const folded = chips.length - shown + beyond;
  if (folded === 0) more.style.display = 'none';
  else more.textContent = `+${folded}`;
  chips.forEach((chip, at) => {
    if (at >= shown) chip.style.display = 'none';
  });
}

const styles = stylex.create({
  chips: {
    display: 'flex',
    alignItems: 'center',
    gap: spacingVars['--spacing-1'],
    minWidth: 0,
    overflow: 'hidden',
  },
  chip: {
    display: 'inline-flex',
    alignItems: 'center',
    flexShrink: 0,
    gap: '3px',
    height: tm.chipHeight,
    paddingInlineStart: '5px',
    paddingInlineEnd: '6px',
    borderRadius: radiusVars['--radius-full'],
    boxShadow: `inset 0 0 0 1px ${tm.rule}`,
    outline: { default: null, [media.forcedColors]: '1px solid CanvasText' },
    outlineOffset: '-1px',
    color: colorVars['--color-text-secondary'],
    fontFamily: typographyVars['--font-family-body'],
    fontSize: tm.chipText,
    fontWeight: fontWeightVars['--font-weight-medium'],
    lineHeight: 1,
    whiteSpace: 'nowrap',
  },
  // Ink on the neutral plate, as an avatar's initials are, reads at 4.5:1 in both themes.
  asks: {
    backgroundColor: colorVars['--color-neutral'],
    boxShadow: 'none',
    color: colorVars['--color-text-primary'],
    fontWeight: fontWeightVars['--font-weight-semibold'],
  },
  icon: {
    width: tm.chipIcon,
    height: tm.chipIcon,
    color: 'inherit',
  },
});
