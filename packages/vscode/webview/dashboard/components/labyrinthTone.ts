// The kind -> theme-var table the map's tones are painted from.
//
// It exists because the exported atlas puts a COLOUR SWATCH on each kind filter,
// and a swatch drawn from a private copy of the palette is a second colour
// language for the same run — the chip and the marker would drift apart the
// first time either is touched. LabyrinthNode.svelte's `.tone-*` rules and this
// table are asserted to be the SAME pairs in labyrinthAtlas.test.ts, so a change
// to one without the other is a red test rather than a quietly wrong legend.
//
// Vars only, never a literal: the export resolves these against the live root
// exactly as it resolves the map's own colours.

import type { LaneStep } from './labyrinthLanes';

/** One `--og-*` name per step kind. Mirrors LabyrinthNode.svelte's tone rules. */
export const TONE_VARS: Record<LaneStep['kind'], string> = {
  prompt: '--og-chat',
  reply: '--og-text',
  thinking: '--og-text-muted',
  tool: '--og-success',
  subagent: '--og-accent-2',
  error: '--og-error',
};

/**
 * The swatch colour for a kind, as a var reference for the export's resolver.
 * An unrecognised kind falls back to the node's own resting colour rather than
 * to an invented hue — a run carrying a kind this build does not know about
 * gets a neutral chip, not a wrong one.
 */
export function toneVar(kind: string): string {
  return `var(${TONE_VARS[kind as LaneStep['kind']] ?? '--og-text-secondary'})`;
}
