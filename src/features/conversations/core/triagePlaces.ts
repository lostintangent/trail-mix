/** Where the reader draws a conversation's actions: a desktop's bar, or a phone's top and island. */
export type ActionsPlace = 'bar' | 'top' | 'island';

/** The triage controls drawn together: filing, which archives, deletes and moves, marking, or both. */
export type TriagePart = 'all' | 'filing' | 'marking';

/**
 * Which triage controls a place shows, if it shows any. A desktop's bar shows them all, and a
 * phone, which has no bar, splits them: marking at the top of the screen and filing in the island,
 * beside its main action. A desktop draws no top bar and no island.
 */
export function triageAt(place: ActionsPlace, isPhone: boolean): TriagePart | undefined {
  if (isPhone === (place === 'bar')) return undefined;
  return place === 'bar' ? 'all' : place === 'top' ? 'marking' : 'filing';
}
