// glyphNames.ts: what a glyph is called, split out of collabGlyphs.ts (art
// data stayed there; naming rules moved here).
//
// Three things this layer does:
//  1. Strip the filing prefix: a bot def is `collab-crane`, not `crane`.
//  2. Resolve an alias: some glyph sets are keyed by agent type rather than
//     by the creature drawn (`architect` is an elephant). The picker offers
//     them under the animal name, which resolves back to the one polygon
//     set — an alias, never a second copy.
//  3. Say which keys are offered: every alias, plus every table key that is
//     already a creature's name. The archetype ids stay hidden so the same
//     drawing never appears twice in the grid under two names.
//
// Pure, with no import of the glyph table: `offeredGlyphKeys` is handed the
// table's keys instead, since archetypeGlyphs.ts imports this module and
// importing back would be a cycle.

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

/** Slug or archetype id -> the key it is actually stored under. Unknown ids
 *  pass through unchanged, so the caller's `?? null` still decides meaning. */
export function glyphKey(id: string): string {
  const bare = id.startsWith('collab-') ? id.slice('collab-'.length) : id;
  return ALIASES[bare] ?? bare;
}

/**
 * The keys the picker offers, sorted. An aliased key is offered under its
 * animal name, not its archetype id; `scout` survives unaliased since it
 * is a bird drawn for this board with no other name.
 */
export function offeredGlyphKeys(tableKeys: readonly string[]): string[] {
  const aliased = new Set(Object.values(ALIASES));
  return [...Object.keys(ALIASES), ...tableKeys.filter((key) => !aliased.has(key))].sort();
}
