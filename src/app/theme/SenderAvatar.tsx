import {
  colorVars,
  fontWeightVars,
  radiusVars,
  typographyVars,
} from '@astryxdesign/core/theme/tokens.stylex';
import * as stylex from '@stylexjs/stylex';
import { useState } from 'react';
import type { StampColor } from '../../features/mail/core/index.ts';
import { stampStyles } from './stamps.ts';
import { tm } from './tokens.stylex.ts';

/**
 * Who a message is from, as a round mark 32 pixels across: their picture when their mail is
 * verified and one is known, or their initials on a quiet plate, also when the picture fails to
 * load. A picture fills its circle on a light plate in both themes, so a transparent icon drawn for
 * light pages still reads in the dark theme. Where a list
 * mixes accounts, the account's stamp lies on its corner like a postmark. It repeats the name
 * beside it, so assistive technology passes over it.
 *
 * It draws Astryx's Avatar plate itself, with Astryx's tokens. Every row of the list leads with
 * one, so it loads with the first screen, and Avatar's tooltip, link and status-label machinery,
 * which none of them uses, would take about 3 KB of the first load's 250.
 */
export function SenderAvatar({
  name,
  picture,
  stamp,
}: {
  name: string;
  /** Where the sender's picture is served, when there is one to show. */
  picture?: string;
  stamp?: StampColor;
}) {
  const [failed, setFailed] = useState<string>();
  const showsPicture = picture !== undefined && failed !== picture;
  return (
    <span aria-hidden data-avatar {...stylex.props(styles.avatar)}>
      <span {...stylex.props(styles.plate, showsPicture ? styles.lightPlate : styles.initials)}>
        {showsPicture ? (
          <img
            src={picture}
            alt=""
            onError={() => setFailed(picture)}
            {...stylex.props(styles.picture)}
          />
        ) : (
          initialsOf(name)
        )}
      </span>
      {stamp && <span data-stamp={stamp} {...stylex.props(styles.stamp, stampStyles[stamp])} />}
    </span>
  );
}

/**
 * Up to two letters for a name: the first of its first word and of its last, as Astryx's Avatar
 * takes them. Words are runs that start with a letter or a digit, so an address gives its first.
 */
export function initialsOf(name: string): string {
  const words = name.split(/\s+/).filter((word) => /^[\p{L}\p{N}]/u.test(word));
  const [first, last] = [words[0], words.length > 1 ? words.at(-1) : undefined];
  return [first, last]
    .map((word) => (word ? [...word][0] : ''))
    .join('')
    .toUpperCase();
}

const styles = stylex.create({
  avatar: {
    position: 'relative',
    display: 'inline-flex',
    flexShrink: 0,
    width: '32px',
    height: '32px',
  },
  plate: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '100%',
    height: '100%',
    overflow: 'hidden',
    borderRadius: radiusVars['--radius-full'],
  },
  // Primary text on the neutral plate, as Astryx's Avatar sets it, reads at 4.5:1 in both themes.
  initials: {
    backgroundColor: colorVars['--color-neutral'],
    color: {
      default: colorVars['--color-text-primary'],
      '@media (forced-colors: active)': 'CanvasText',
    },
    fontFamily: typographyVars['--font-family-body'],
    // Two letters fit the circle at 40% of its size, as on Astryx's Avatar.
    fontSize: '12.8px',
    fontWeight: fontWeightVars['--font-weight-medium'],
    lineHeight: 1,
  },
  // Light in both themes, as the pages pictures are drawn for are, so a transparent one reads.
  lightPlate: {
    backgroundColor: tm.paperFixed,
  },
  picture: {
    width: '100%',
    height: '100%',
    objectFit: 'cover',
  },
  // A postmark on the circle's lower corner, ringed in the sheet's paper so it reads on any logo.
  // Its center lies where the circle's edge crosses the diagonal, 32 × (1 − 1/√2) / 2 ≈ 4.7 pixels
  // in from each side, less half its 10 pixels.
  stamp: {
    position: 'absolute',
    insetInlineEnd: '-0.3px',
    bottom: '-0.3px',
    width: '10px',
    height: '10px',
    borderRadius: radiusVars['--radius-full'],
    boxShadow: `0 0 0 2px ${colorVars['--color-background-surface']}`,
    forcedColorAdjust: 'none',
  },
});
