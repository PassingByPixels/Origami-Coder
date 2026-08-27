// Collabs M2 - collabGlyphs.ts: the two glyph sets drawn FOR THIS BOARD, kept
// out of archetypeGlyphs.ts because that file had 13 lines under its cap and the
// ratchet's remedy is a module, never a raised number.
//
// W9 SPLIT THIS FILE'S SECOND JOB OUT. It also held the slug-to-table-key rule
// and the alias table; both moved to glyphNames.ts when the menagerie arrived
// and the alias table grew from one entry to seven. Same reasoning as the
// original split, one level down: art and names change for different reasons,
// and this file was at 80 of its 85 cap. What is left here is art.
//
// Both sets below are new art in the established style: a 64x64 viewBox of
// currentColor polygons with per-polygon opacity, group opacity flattened in.

import type { GlyphPoly } from './archetypeGlyphs';

/**
 * heron - authored for the collab seed pair, deliberately NOT a re-cut crane.
 *
 * The tsuru reads as a wide horizontal wingspan (its outermost points are at
 * x=2 and x=62, y under 20). This one is the opposite silhouette: a standing
 * bird on two long legs, an S-neck rising to the right, a long straight
 * dagger beak and a head plume, with the tail swept back low and left. At
 * 12px the two must still be told apart by outline alone, so the difference
 * is carried by the POSTURE, not by detail that vanishes at glyph size.
 */
export const HERON: GlyphPoly[] = [
  // legs (the source family's <g opacity=".45"> convention, flattened in)
  { pts: '26,44 28.5,44 27,60 24.5,60', op: 0.45 },
  { pts: '33,44 35.5,44 37.5,60 35,60', op: 0.45 },
  // the S-neck, folded as two facets so it reads as paper, not a tube
  { pts: '38,30 42,29 40,16 37,17', op: 0.9 },
  { pts: '40,16 43.5,15 45,8 41.5,9', op: 0.7 },
  // head, then the long straight beak that names the bird
  { pts: '41.5,9 46.5,6.5 48,13 43.5,15', op: 1 },
  { pts: '48,11 62,15.5 47.5,14', op: 0.85 },
  // the plume off the back of the head
  { pts: '43,7.5 36,3 41.5,9', op: 0.55 },
  // body: breast and back as one deep fold, plus the shoulder behind it
  { pts: '20,33 38,30 42,29 40,45 25,46', op: 0.95 },
  { pts: '20,33 25,46 15,42', op: 0.6 },
  // the folded wing - the one facet that catches the light
  { pts: '23,34 39,32 33,44 25,43', op: 0.72 },
  // tail, swept back and down
  { pts: '15,42 25,46 8,52 6,46', op: 0.8 },
];

/**
 * scout - the read-only recon archetype's glyph (Folds Board D7). Where the
 * heron above reads as tall and still (a long S-neck, legs planted), this
 * one reads as ALERT and airborne: banked into a turn, one wing swept up and
 * back, head low and forward, no legs at all - a bird already scouting, not
 * standing. The raised wing and the missing legs are what tell it apart from
 * the other two at glyph size.
 */
export const SCOUT: GlyphPoly[] = [
  { pts: '18,32 34,25 40,38 24,45', op: 0.9 },
  { pts: '18,32 24,45 12,40', op: 0.55 },
  { pts: '20,30 8,10 34,25', op: 1 },
  { pts: '8,10 22,20 34,25', op: 0.7 },
  { pts: '24,45 40,52 30,40', op: 0.6 },
  { pts: '34,25 46,20 44,32 38,33', op: 0.85 },
  { pts: '46,20 56,19 44,25', op: 0.65 },
  { pts: '12,40 4,48 18,44', op: 0.5 },
];
