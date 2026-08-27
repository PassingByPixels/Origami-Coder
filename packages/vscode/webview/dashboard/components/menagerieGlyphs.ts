// menagerieGlyphs.ts (W9) - the ORIGAMI MENAGERIE: twenty-six more creatures a
// bot can wear, in the same visual language as the seven brand glyphs
// archetypeGlyphs.ts already held.
//
// WHY THIS FILE EXISTS. Until W9 a bot's glyph came from a list of NINE, seven
// of which were named after AGENT TYPES rather than animals (`architect` for the
// elephant, `debug` for the fox). Two bots in three therefore wore the same
// bird, and the picker's job - "which one is mine, at a glance, in a list" -
// cannot be done by nine marks. The owner's ruling was simply: many more.
//
// THE STYLE IS NOT NEGOTIABLE, because a menagerie that is half low-poly paper
// and half something else reads as a bug rather than as variety. Every set here
// obeys the same four rules the harvested originals do:
//
//   1. A 64x64 VIEWBOX. Nothing else; ArchetypeGlyph.svelte hard-codes it.
//   2. POLYGONS ONLY - no curves, no strokes, no circles. An origami animal is
//      flat facets meeting at folds, and a curve is the one thing paper cannot
//      do. Three or four points per polygon, straight edges.
//   3. PER-POLYGON OPACITY, 0.45 to 1.0, and it is what does the work: the same
//      currentColor fill at different alphas reads as one sheet catching light
//      at different angles. A flat set of equal opacities looks like a blob.
//      The family convention for a LEG or a shadow is 0.45 - lifted from the
//      source SVGs' `<g opacity=".45">`, flattened per polygon.
//   4. currentColor, INHERITED. There is no fill attribute anywhere in this
//      file. The renderer sets `fill="currentColor"` once on the <svg>, so a
//      glyph takes the colour of the text beside it in all five themes - which
//      is also why architecture.test.ts's colour rule has nothing to find here.
//
// READ AT 16px FIRST. Every one of these is drawn at 12-32px, so the SILHOUETTE
// carries it and interior detail is wasted ink: two long ears say rabbit, a
// radial mane says lion, a fan says peacock. Where two creatures would share an
// outline they are posed apart on purpose - the swan floats with no legs and a
// tight neck where the heron stands tall on two, and the eagle spreads straight
// where the bat's wings are scalloped.
//
// DATA ONLY, and no import of `vscode` or of the lookup that uses it, so the
// table can be enumerated and every polygon parsed by a test with no DOM
// (glyphRegistry.test.ts does exactly that).

import type { GlyphPoly } from './archetypeGlyphs';

export const MENAGERIE: Record<string, GlyphPoly[]> = {
  // Sitting, ears up - the two long verticals are the whole silhouette.
  rabbit: [
    { pts: '21,14 25,2 27,26', op: 0.7 },
    { pts: '28,26 33,3 36,15', op: 0.95 },
    { pts: '18,24 36,26 33,40 20,38', op: 1 },
    { pts: '18,30 10,34 20,38', op: 0.6 },
    { pts: '20,36 42,32 50,50 24,54', op: 0.9 },
    { pts: '34,36 50,40 46,52', op: 0.6 },
    { pts: '48,38 58,34 52,46', op: 0.75 },
    { pts: '24,50 46,50 44,58 22,58', op: 0.45 },
  ],
  // Heavy and low, small round ears - the opposite mass to the wolf's.
  bear: [
    { pts: '22,46 29,46 28,59 22,59', op: 0.45 },
    { pts: '40,45 47,45 46,59 40,59', op: 0.45 },
    { pts: '13,15 20,9 23,18', op: 0.7 },
    { pts: '31,17 38,10 40,20', op: 0.85 },
    { pts: '12,16 40,19 37,35 15,33', op: 1 },
    { pts: '12,24 3,29 14,33', op: 0.6 },
    { pts: '15,31 40,30 50,48 20,52', op: 0.9 },
    { pts: '34,34 50,38 47,50', op: 0.55 },
  ],
  // Wide head, two tufts, a facial disc split down the middle.
  owl: [
    { pts: '15,20 17,6 24,17', op: 0.7 },
    { pts: '40,17 47,6 49,20', op: 0.7 },
    { pts: '14,20 50,20 46,36 18,36', op: 1 },
    { pts: '20,22 31,22 26,34', op: 0.5 },
    { pts: '33,22 44,22 38,34', op: 0.5 },
    { pts: '30,27 34,27 32,34', op: 0.9 },
    { pts: '18,34 46,34 40,56 24,56', op: 0.85 },
    { pts: '18,34 27,42 24,56', op: 0.6 },
    { pts: '46,34 37,42 40,56', op: 0.6 },
    { pts: '25,54 31,54 30,60 24,60', op: 0.45 },
    { pts: '33,54 39,54 40,60 34,60', op: 0.45 },
  ],
  // A faceted dome over a flat rim - the shell IS the recognition.
  turtle: [
    { pts: '13,36 32,17 51,36', op: 1 },
    { pts: '32,17 51,36 32,36', op: 0.7 },
    { pts: '11,36 53,36 49,44 15,44', op: 0.9 },
    { pts: '13,31 3,33 5,40 13,40', op: 0.85 },
    { pts: '15,42 5,49 17,49', op: 0.5 },
    { pts: '49,42 59,49 47,49', op: 0.5 },
    { pts: '21,43 24,52 30,45', op: 0.45 },
    { pts: '43,43 40,52 34,45', op: 0.45 },
  ],
  // Squat and wider than tall, eyes ON TOP, back legs folded out sideways.
  frog: [
    { pts: '17,22 23,13 28,23', op: 0.85 },
    { pts: '36,23 41,13 47,22', op: 0.85 },
    { pts: '13,24 51,24 45,44 19,44', op: 1 },
    { pts: '13,24 51,24 32,33', op: 0.5 },
    { pts: '19,38 5,48 15,54 23,46', op: 0.8 },
    { pts: '45,38 59,48 49,54 41,46', op: 0.8 },
    { pts: '24,42 20,55 27,55', op: 0.55 },
    { pts: '40,42 44,55 37,55', op: 0.55 },
  ],
  // Four wings around a thin body: the one glyph read as a shape, not a pose.
  butterfly: [
    { pts: '30,30 5,7 15,32', op: 1 },
    { pts: '34,30 59,7 49,32', op: 0.85 },
    { pts: '30,33 9,54 23,40', op: 0.7 },
    { pts: '34,33 55,54 41,40', op: 0.6 },
    { pts: '30,18 34,18 33,50 31,50', op: 0.95 },
    { pts: '31,19 22,8 32,17', op: 0.5 },
    { pts: '33,19 42,8 32,17', op: 0.5 },
  ],
  // A fish told by its TAIL: the split fan is what separates it from the whale.
  koi: [
    { pts: '9,32 34,17 34,32', op: 1 },
    { pts: '9,32 34,32 34,47', op: 0.7 },
    { pts: '34,17 50,26 50,38 34,47', op: 0.9 },
    { pts: '49,32 62,19 58,32 62,45', op: 0.8 },
    { pts: '27,20 34,8 40,22', op: 0.55 },
    { pts: '26,35 21,47 33,39', op: 0.5 },
    { pts: '13,29 19,28 16,34', op: 0.45 },
  ],
  // Mass low and forward, fluke horizontal, one small spout facet.
  whale: [
    { pts: '5,31 26,21 45,26 51,33', op: 1 },
    { pts: '5,31 51,33 40,44 14,42', op: 0.85 },
    { pts: '14,42 40,44 26,47', op: 0.55 },
    { pts: '50,33 62,20 57,33 62,45', op: 0.9 },
    { pts: '25,42 28,53 36,44', op: 0.5 },
    { pts: '15,24 12,9 19,22', op: 0.45 },
  ],
  // Dome over a curtain of arms; the arms are separate facets so the fringe
  // survives at 16px where one blob would not.
  octopus: [
    { pts: '20,9 44,9 49,28 15,28', op: 1 },
    { pts: '20,9 44,9 32,28', op: 0.8 },
    { pts: '16,27 22,29 17,48 11,44', op: 0.7 },
    { pts: '22,28 29,29 27,52 20,50', op: 0.85 },
    { pts: '29,29 35,29 34,55 28,55', op: 0.6 },
    { pts: '35,29 42,28 45,50 38,52', op: 0.8 },
    { pts: '42,29 48,27 53,44 47,48', op: 0.55 },
    { pts: '13,26 8,36 4,30', op: 0.45 },
    { pts: '51,26 56,36 60,30', op: 0.45 },
  ],
  // Wide shell, two raised claws, four legs a side dropped to 0.5.
  crab: [
    { pts: '14,25 50,25 46,41 18,41', op: 1 },
    { pts: '14,25 50,25 32,33', op: 0.6 },
    { pts: '15,27 4,18 11,11 18,22', op: 0.9 },
    { pts: '49,27 60,18 53,11 46,22', op: 0.9 },
    { pts: '19,40 10,52 17,52', op: 0.5 },
    { pts: '26,41 22,54 29,54', op: 0.5 },
    { pts: '38,41 42,54 35,54', op: 0.5 },
    { pts: '45,40 54,52 47,52', op: 0.5 },
    { pts: '24,28 29,28 27,33', op: 0.45 },
    { pts: '35,28 40,28 37,33', op: 0.45 },
  ],
  // Small body, eight legs as long folded strips - the legs are the animal.
  spider: [
    { pts: '25,24 39,24 42,40 22,40', op: 1 },
    { pts: '27,16 37,16 39,25 25,25', op: 0.85 },
    { pts: '25,26 8,14 5,22 22,32', op: 0.6 },
    { pts: '24,31 4,32 7,40 23,36', op: 0.75 },
    { pts: '23,36 8,48 14,54 25,40', op: 0.55 },
    { pts: '39,26 56,14 59,22 42,32', op: 0.6 },
    { pts: '40,31 60,32 57,40 41,36', op: 0.75 },
    { pts: '41,36 56,48 50,54 39,40', op: 0.55 },
  ],
  // An S laid on the ground, head raised at the top left: a chain of facets,
  // which is exactly how a paper snake is folded.
  snake: [
    { pts: '8,50 30,44 34,52 10,58', op: 0.9 },
    { pts: '30,44 52,38 55,47 34,52', op: 0.75 },
    { pts: '52,38 56,26 47,24 44,36', op: 0.85 },
    { pts: '47,24 30,20 28,29 45,33', op: 1 },
    { pts: '30,20 18,14 14,22 28,29', op: 0.7 },
    { pts: '18,14 22,6 30,9 26,17', op: 0.95 },
    { pts: '26,9 34,7 30,13', op: 0.55 },
  ],
  // Standing, head low and left, tail swept back - a long horizontal read.
  horse: [
    { pts: '20,38 25,38 24,58 19,58', op: 0.45 },
    { pts: '44,38 49,38 50,58 45,58', op: 0.45 },
    { pts: '9,14 14,5 18,14', op: 0.7 },
    { pts: '6,12 20,15 18,26 5,22', op: 1 },
    { pts: '5,22 18,26 8,30', op: 0.6 },
    { pts: '17,20 32,30 26,40 14,28', op: 0.9 },
    { pts: '19,17 30,28 24,29', op: 0.55 },
    { pts: '24,30 52,28 54,44 22,42', op: 0.95 },
    { pts: '50,28 62,20 58,34 54,40', op: 0.7 },
  ],
  // A HEAD-ON mask, not a body: the two horns sweeping out of a heavy brow are
  // unmistakable at any size, and nothing else in the set is symmetrical this way.
  bull: [
    { pts: '10,20 3,10 14,14', op: 0.8 },
    { pts: '54,20 61,10 50,14', op: 0.8 },
    { pts: '12,15 52,15 46,34 18,34', op: 1 },
    { pts: '18,34 46,34 40,52 24,52', op: 0.85 },
    { pts: '24,52 40,52 36,58 28,58', op: 0.6 },
    { pts: '18,18 27,18 23,30', op: 0.5 },
    { pts: '37,18 46,18 41,30', op: 0.5 },
  ],
  // Also head-on, and told from the bull by the horns CURLING back on
  // themselves instead of sweeping up.
  ram: [
    { pts: '22,16 40,16 38,34 24,34', op: 1 },
    { pts: '24,34 38,34 35,48 27,48', op: 0.85 },
    { pts: '22,18 10,12 4,22 10,34 20,32', op: 0.7 },
    { pts: '10,20 16,20 14,28', op: 0.45 },
    { pts: '40,18 52,12 58,22 52,34 42,32', op: 0.7 },
    { pts: '46,20 52,20 50,28', op: 0.45 },
    { pts: '24,12 32,6 40,12', op: 0.6 },
    { pts: '28,48 34,48 33,56 29,56', op: 0.5 },
  ],
  // Ears too big for the head, and a tail as long as the body: the two
  // exaggerations that stop it reading as a small bear.
  mouse: [
    { pts: '13,24 6,14 18,14', op: 0.7 },
    { pts: '30,22 26,10 39,13', op: 0.85 },
    { pts: '12,22 38,20 42,38 16,40', op: 1 },
    { pts: '12,30 3,36 16,40', op: 0.6 },
    { pts: '16,36 44,32 50,50 20,52', op: 0.9 },
    { pts: '36,36 50,40 47,50', op: 0.5 },
    { pts: '49,44 60,40 62,46 50,50', op: 0.75 },
    { pts: '22,48 46,48 44,56 22,56', op: 0.45 },
  ],
  // Wings SCALLOPED (the double notch on each side), which is what tells it
  // from the eagle's straight span at glyph size.
  bat: [
    { pts: '26,20 31,12 33,20', op: 0.7 },
    { pts: '33,20 35,12 40,20', op: 0.7 },
    { pts: '25,19 41,19 39,34 27,34', op: 1 },
    { pts: '26,22 4,14 10,28 3,30 14,38 26,32', op: 0.85 },
    { pts: '40,22 62,14 56,28 63,30 52,38 40,32', op: 0.85 },
    { pts: '27,33 39,33 36,46 30,46', op: 0.6 },
  ],
  // Upright teardrop with a pale front panel and two flat feet.
  penguin: [
    { pts: '22,10 42,10 46,28 20,28', op: 1 },
    { pts: '20,26 46,26 50,52 16,52', op: 0.9 },
    { pts: '26,24 40,24 42,50 24,50', op: 0.5 },
    { pts: '44,16 56,20 44,22', op: 0.8 },
    { pts: '20,30 12,40 18,48', op: 0.7 },
    { pts: '46,30 54,40 48,48', op: 0.7 },
    { pts: '18,52 28,52 26,58 14,58', op: 0.45 },
    { pts: '38,52 48,52 52,58 40,58', op: 0.45 },
  ],
  // FLOATING, and that is the whole difference from the heron: a fat waterline
  // body, a tight neck curl, and no legs at all.
  swan: [
    { pts: '34,26 40,25 42,12 36,12', op: 0.9 },
    { pts: '36,12 42,10 48,15 44,20', op: 1 },
    { pts: '48,14 60,17 47,19', op: 0.7 },
    { pts: '10,34 34,26 40,25 44,42 16,44', op: 0.95 },
    { pts: '10,34 16,44 4,40', op: 0.6 },
    { pts: '14,30 36,29 30,40 18,40', op: 0.55 },
    { pts: '4,44 46,44 42,50 8,50', op: 0.45 },
  ],
  // Wings STRAIGHT and level, hooked beak, tail square: a heraldic pose, which
  // is what keeps it apart from both the crane and the bat.
  eagle: [
    { pts: '28,18 36,18 38,30 26,30', op: 1 },
    { pts: '36,20 48,22 36,26', op: 0.85 },
    { pts: '26,26 4,10 8,26 2,30 22,36', op: 0.9 },
    { pts: '38,26 60,10 56,26 62,30 42,36', op: 0.75 },
    { pts: '26,29 38,29 40,46 24,46', op: 0.95 },
    { pts: '26,44 38,44 34,58 30,58', op: 0.6 },
    { pts: '24,44 20,54 28,50', op: 0.45 },
    { pts: '40,44 44,54 36,50', op: 0.45 },
  ],
  // The fan is eight wedges off ONE point, which is both how the bird displays
  // and how a folded paper fan actually works.
  peacock: [
    { pts: '32,44 6,26 4,44', op: 0.5 },
    { pts: '32,44 12,16 6,26', op: 0.6 },
    { pts: '32,44 24,8 14,15', op: 0.7 },
    { pts: '32,44 32,4 24,8', op: 0.85 },
    { pts: '32,44 40,8 32,4', op: 0.75 },
    { pts: '32,44 50,15 40,8', op: 0.65 },
    { pts: '32,44 58,26 52,16', op: 0.55 },
    { pts: '32,44 60,44 58,26', op: 0.45 },
    { pts: '27,36 37,36 36,52 28,52', op: 1 },
    { pts: '29,28 35,28 37,37 27,37', op: 0.9 },
    { pts: '35,30 44,32 35,34', op: 0.7 },
  ],
  // The mane is a radial ring of wedges around a square muzzle - the same fan
  // trick as the peacock, closed into a circle so the two cannot be confused.
  lion: [
    { pts: '32,32 10,10 8,30', op: 0.55 },
    { pts: '32,32 20,4 10,10', op: 0.65 },
    { pts: '32,32 32,2 20,4', op: 0.5 },
    { pts: '32,32 44,4 32,2', op: 0.6 },
    { pts: '32,32 54,10 44,4', op: 0.5 },
    { pts: '32,32 56,30 54,10', op: 0.65 },
    { pts: '32,32 54,52 58,32', op: 0.55 },
    { pts: '32,32 44,60 54,52', op: 0.6 },
    { pts: '32,32 20,60 44,60', op: 0.5 },
    { pts: '32,32 10,52 20,60', op: 0.6 },
    { pts: '32,32 6,32 10,52', op: 0.55 },
    { pts: '20,20 44,20 42,40 22,40', op: 1 },
    { pts: '25,40 39,40 36,50 28,50', op: 0.9 },
  ],
  // Round head, round ears, and the eye patches carried as low-opacity facets -
  // the only creature here whose MARKINGS are part of the outline.
  panda: [
    { pts: '14,16 22,8 26,18', op: 0.9 },
    { pts: '38,18 42,8 50,16', op: 0.9 },
    { pts: '14,18 50,18 46,36 18,36', op: 1 },
    { pts: '20,22 29,22 25,32', op: 0.5 },
    { pts: '35,22 44,22 40,32', op: 0.5 },
    { pts: '18,34 46,34 50,54 14,54', op: 0.85 },
    { pts: '18,34 26,44 14,54', op: 0.55 },
    { pts: '46,34 38,44 50,54', op: 0.55 },
    { pts: '16,52 28,52 26,59 14,59', op: 0.45 },
    { pts: '36,52 48,52 50,59 38,59', op: 0.45 },
  ],
  // Two PAIRS of narrow wings and a needle abdomen: nothing else in the set is
  // this thin, which is what makes it legible beside the butterfly.
  dragonfly: [
    { pts: '29,14 35,14 34,26 30,26', op: 1 },
    { pts: '29,10 35,10 35,15 29,15', op: 0.85 },
    { pts: '30,26 34,26 33,56 31,56', op: 0.95 },
    { pts: '30,20 4,14 6,22 30,24', op: 0.7 },
    { pts: '34,20 60,14 58,22 34,24', op: 0.7 },
    { pts: '30,26 8,28 10,36 30,31', op: 0.5 },
    { pts: '34,26 56,28 54,36 34,31', op: 0.5 },
  ],
  // A hard oval SPLIT down the middle - the elytra seam is the recognition,
  // and it is one straight fold, which paper does better than anything.
  beetle: [
    { pts: '26,8 38,8 40,16 24,16', op: 0.9 },
    { pts: '28,4 30,10 26,9', op: 0.5 },
    { pts: '36,4 34,10 38,9', op: 0.5 },
    { pts: '22,16 42,16 44,26 20,26', op: 1 },
    { pts: '20,26 32,26 30,54 22,48', op: 0.85 },
    { pts: '44,26 32,26 34,54 42,48', op: 0.65 },
    { pts: '20,28 8,24 6,32 20,34', op: 0.5 },
    { pts: '44,28 56,24 58,32 44,34', op: 0.5 },
    { pts: '21,38 10,42 12,48 22,44', op: 0.45 },
    { pts: '43,38 54,42 52,48 42,44', op: 0.45 },
  ],
  // Vertical, snouted, and it ends in a CURL - the only tail in the set that
  // turns back on itself, which is the whole silhouette.
  seahorse: [
    { pts: '22,10 34,6 36,16 24,18', op: 1 },
    { pts: '34,8 46,4 38,14', op: 0.7 },
    { pts: '20,10 24,4 26,12', op: 0.55 },
    { pts: '24,17 36,16 34,28 22,26', op: 0.9 },
    { pts: '22,26 34,28 33,40 24,38', op: 0.8 },
    { pts: '36,20 46,22 36,26', op: 0.5 },
    { pts: '24,38 33,40 30,50 22,48', op: 0.7 },
    { pts: '22,48 30,50 32,58 22,58', op: 0.85 },
    { pts: '22,54 32,58 20,60 16,54', op: 0.6 },
  ],
};
