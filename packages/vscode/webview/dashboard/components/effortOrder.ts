// effortOrder.ts — ranks the Effort popover's options by strength, whatever
// order the backend advertised them in.
//
// codexCatalog.ts (engine) deliberately does NOT sort: it says "no table in
// this repo knows that [ranking]" and keeps the backend's own order, only
// moving the default to the front. A ChatGPT catalog entry can list its
// levels as [medium, low, high, xhigh, max, ultra] (default first, per
// catalogDefaultFirst) — rendered verbatim that reads as a shuffled deck.
// This is the table the engine explicitly does not own; it belongs at the
// one place the list is shaped for DISPLAY, not where the engine decides
// what is offered or which one starts selected.

/** Known reasoning levels, weakest to strongest. Anything not in this table
 *  is "unknown" and sorts after every known level. */
const RANK: Record<string, number> = {
  none: 0,
  minimal: 1,
  low: 2,
  medium: 3,
  high: 4,
  xhigh: 5,
  max: 6,
  ultra: 7,
};

/**
 * Sort effort options by rank. Unknown names (not in RANK) are pushed after
 * all known ones, keeping their advertised relative order among themselves —
 * `Array.prototype.sort` is spec-guaranteed stable, so ties (unknown vs.
 * unknown) never reorder against each other.
 *
 * `current` (which option is lit) is never read or touched here: the caller
 * matches it against `value` after sorting, same as before.
 */
export function orderEffortLevels<T extends { value: string }>(options: readonly T[]): T[] {
  const rank = (value: string) => RANK[value] ?? Number.MAX_SAFE_INTEGER;
  return [...options].sort((a, b) => rank(a.value) - rank(b.value));
}
