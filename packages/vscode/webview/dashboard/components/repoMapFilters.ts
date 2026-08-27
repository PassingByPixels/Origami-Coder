// The map screen's FILTER + LABEL rules, as pure functions with no DOM.
//
// They are here rather than inline in the pane for the usual reason: what a
// search matches, and which captions a crowded picture is allowed to draw, are
// decisions with edge cases (a node with no path, a kind the palette never heard
// of, an empty query) that are trivial to assert on plain objects and invisible
// in a screenshot. The pane below them only wires events.
//
// `kindsIn` is the one function that also exists on the host (mapPalette.ts). It
// is four lines of ordering, not a constant table, so it is NOT in the mirror's
// drift guard — the guard covers the tables both sides must agree on.

import { KIND_ORDER } from './repoMapPalette';

/** The slice of a component the filters read. IsoBox satisfies it. */
export interface FilterNode {
  id: string;
  name: string;
  kind: string;
  path?: string;
  summary: string;
  section?: string;
  pillar: number;
}

/** Count by an extracted key, in first-seen order. */
export function countBy<T, K>(items: readonly T[], key: (t: T) => K): Map<K, number> {
  const out = new Map<K, number>();
  for (const it of items) {
    const k = key(it);
    out.set(k, (out.get(k) ?? 0) + 1);
  }
  return out;
}

/** The kinds a legend should list: the known ones in palette order, then whatever
 *  else the map actually used, sorted. `kind` is a free string in the schema, so
 *  a legend built only from the palette would under-count the picture it labels
 *  and offer no filter for the components it left out. */
export function kindsIn(kinds: Iterable<string>): string[] {
  const seen = new Set(kinds);
  return [
    ...KIND_ORDER.filter((k) => seen.has(k)),
    ...[...seen].filter((k) => !KIND_ORDER.includes(k)).sort(),
  ];
}

/** Does this component survive the current search and toggles?
 *
 *  The query is matched against everything a reader might type — name, kind,
 *  path, summary, section — because "find a component" fails silently and
 *  annoyingly when it only searches the name. An empty query matches everything;
 *  it is not "match nothing". */
export function matches(
  n: FilterNode, query: string, hiddenKinds: ReadonlySet<string>, hiddenPillars: ReadonlySet<number>,
): boolean {
  if (hiddenKinds.has(n.kind) || hiddenPillars.has(n.pillar)) return false;
  const q = query.trim().toLowerCase();
  if (q === '') return true;
  return `${n.name} ${n.kind} ${n.path ?? ''} ${n.summary} ${n.section ?? ''}`.toLowerCase().includes(q);
}

export const LABEL_MODES = ['auto', 'all', 'off'] as const;
export type LabelMode = (typeof LABEL_MODES)[number];

export function nextLabelMode(mode: LabelMode): LabelMode {
  return LABEL_MODES[(LABEL_MODES.indexOf(mode) + 1) % LABEL_MODES.length];
}

/** Whether one component's caption is drawn.
 *
 *  AUTO labels what the map itself says matters — anything with an edge or a flow
 *  step — and everything once you have zoomed in. On a 63-node map that is the
 *  difference between a readable picture and a wall of 8px text. */
export function showsName(mode: LabelMode, zoom: number, weight: number): boolean {
  if (mode === 'off') return false;
  return mode === 'all' || zoom > 1.3 || weight > 0;
}
