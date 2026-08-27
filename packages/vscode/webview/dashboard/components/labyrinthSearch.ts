// Filtering the Labyrinth run index. Pure, because the one rule here that a
// screenshot cannot show is the one worth testing: a collab HEADER must
// SURVIVE when any of its MEMBERS matches. The index only offers a member row
// underneath its header (LabyrinthRunIndex.svelte), so dropping a header for
// not matching would delete the only route to a member that did — and a
// member's own map answers "what did THIS agent do", which the merged map
// cannot.

import type { IndexGroup } from './labyrinthCollabIndex';

/** Case-insensitive substring; an absent field simply never matches. */
const has = (hay: string | undefined, needle: string): boolean => (hay ?? '').toLowerCase().includes(needle);

/** Whether a group's OWN fields match. Its members are not consulted here. */
const headMatches = (g: IndexGroup, q: string): boolean => has(g.title, q) || has(g.subtitle, q) || has(g.folder, q);

/**
 * The groups `query` selects, over the header's title / subtitle / folder and
 * each member's agentSlug and title.
 *
 * Two rules the caller must not re-derive:
 *  - a header that matches on its OWN fields keeps ALL its members — the
 *    collab is what matched, so the collab is what is shown;
 *  - a header that does not survives on its matching members alone, carrying
 *    only those.
 *
 * An empty or whitespace query returns the SAME array untouched, so "no
 * filter" costs nothing and can never reorder the index.
 */
export function filterIndex(groups: IndexGroup[], query: string): IndexGroup[] {
  const q = query.trim().toLowerCase();
  if (!q) return groups;
  const out: IndexGroup[] = [];
  for (const g of groups) {
    if (headMatches(g, q)) { out.push(g); continue; }
    const members = g.members.filter((m) => has(m.agentSlug, q) || has(m.title, q));
    if (members.length > 0) out.push({ ...g, members });
  }
  return out;
}

/**
 * How many rows the index actually OFFERS — every header plus every member row
 * under it. Counting groups alone would report a five-agent collab as one row
 * and make "shown of total" lie about what the filter removed.
 */
export function matchCount(groups: readonly IndexGroup[]): number {
  return groups.reduce((n, g) => n + 1 + g.members.length, 0);
}
