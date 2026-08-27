// glyphNames.ts (W9) - WHAT A GLYPH IS CALLED, split out of collabGlyphs.ts.
//
// That file's own header said it held two things: the heron/scout polygon DATA,
// and the slug-to-table-key RULE. They are different jobs with different reasons
// to change - art moves when somebody draws, names move when somebody renames -
// and the file was at 80 of its 85-line cap when the menagerie arrived, so the
// ratchet's remedy applied before a line was written. The data stayed; the names
// came here and grew.
//
// THREE THINGS THE NAME LAYER HAS TO DO:
//
//  1. STRIP THE FILING PREFIX. A bot def is `collab-crane`, not `crane`.
//     Stripping in the lookup beats a duplicate entry per slug: a def renamed
//     `collab-fox` picks up the fox with no edit to the glyph table at all.
//  2. RESOLVE AN ALIAS. Seven of the shipped glyph sets are keyed by an AGENT
//     TYPE rather than by the creature drawn - `architect` is an elephant,
//     `debug` a fox - because that is what they were harvested for. The picker
//     must offer them under the animal's name (nobody browses a menagerie
//     looking for "cartographer"), and the animal name must resolve back to the
//     one polygon set. An alias, never a second copy: two copies of the same
//     twelve polygons is two things to keep in step.
//  3. SAY WHICH KEYS ARE OFFERED. The picker's list is the ANIMALS - every
//     alias, plus every table key that is already a creature's name. The seven
//     archetype ids are deliberately withheld from it: they still resolve (an
//     agent-type card asks for `debug` and gets the fox), but offering both
//     `fox` and `debug` would put the same drawing in the grid twice under two
//     names, which is exactly the confusion the menagerie exists to remove.
//
// PURE, and no import of the glyph table - `offeredGlyphKeys` is HANDED the
// table's keys instead. Not politeness: archetypeGlyphs.ts imports this module,
// so importing it back would be a cycle, and a rule that takes its input as an
// argument is a rule a test can drive with three keys instead of thirty-five.

/** Animal name -> the key its polygon set is already stored under. Every entry
 *  here is a glyph harvested for an AGENT TYPE and named after the type. */
const ALIASES: Record<string, string> = {
  crane: 'tsuru',
  elephant: 'architect',
  cat: 'ask',
  fox: 'debug',
  wolf: 'orchestrator',
  dragon: 'plan',
  deer: 'cartographer',
};

/** Slug or archetype id -> the key the glyph table is actually stored under.
 *  Anything unknown passes through unchanged, so the caller's `?? null` still
 *  decides what an unmapped id means. */
export function glyphKey(id: string): string {
  const bare = id.startsWith('collab-') ? id.slice('collab-'.length) : id;
  return ALIASES[bare] ?? bare;
}

/**
 * The keys the PICKER offers, sorted, given every key the glyph table holds.
 *
 * An aliased key is offered under its animal name and NOT under the archetype
 * id it is stored as; everything else is offered as it stands. `scout` survives
 * that rule deliberately even though it is not an animal name: it is a bird
 * drawn for this board and it has no other name to be offered under.
 */
export function offeredGlyphKeys(tableKeys: readonly string[]): string[] {
  const aliased = new Set(Object.values(ALIASES));
  return [...Object.keys(ALIASES), ...tableKeys.filter((key) => !aliased.has(key))].sort();
}
