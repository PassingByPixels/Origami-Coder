// paneSearch.ts — the filter box's matching rule, shared by the Crons and Loops
// panes so the two cannot drift into disagreeing about what "matches" means.
//
// The rule is deliberately dumb: case-insensitive substring over the fields the
// caller nominates, every whitespace-separated term required (AND, not OR), so
// `nightly triage` narrows rather than widens. No fuzzy matching and no regex —
// a filter that surprises you is worse than one that misses.

/** True when every term in `query` appears in at least one of `fields`. An
 *  empty or whitespace-only query matches everything (no filter is not a
 *  filter that excludes). Absent fields are skipped, never stringified into
 *  "undefined" — which would otherwise make `undefined` a live search term. */
export function matchesSearch(fields: ReadonlyArray<string | null | undefined>, query: string): boolean {
  const terms = query.toLowerCase().split(/\s+/).filter((t) => t.length > 0);
  if (terms.length === 0) return true;
  const hay = fields.filter((f): f is string => typeof f === 'string' && f.length > 0).join('\n').toLowerCase();
  return terms.every((t) => hay.includes(t));
}

/**
 * Which of the three empty states a list is in. "Nothing exists" and "nothing
 * matched" are DIFFERENT FACTS and the pane must never print one for the other:
 * telling someone they have no crons when they have twelve and a stale filter
 * box is exactly the class of lie this codebase keeps hunting.
 */
export type ListState = 'empty' | 'no-matches' | 'has-rows';

export function listState(total: number, shown: number): ListState {
  if (total === 0) return 'empty';
  return shown === 0 ? 'no-matches' : 'has-rows';
}
