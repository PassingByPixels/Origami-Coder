// The map screen's filter + label RULES. Pure functions, so the edge cases that
// are invisible on screen get asserted directly: an empty query matching
// everything rather than nothing, a kind the palette never heard of still getting
// a legend row, and the auto-label rule showing the components the map itself
// says matter instead of a wall of 8px text.

import { describe, expect, it } from 'vitest';
import {
  countBy, kindsIn, matches, nextLabelMode, showsName, type FilterNode,
} from '../components/repoMapFilters';

const node = (id: string, extra: Partial<FilterNode> = {}): FilterNode => ({
  id, name: id, kind: 'service', summary: `${id} does a thing`, pillar: 2, ...extra,
});

const NONE_K = new Set<string>();
const NONE_P = new Set<number>();

describe('the search', () => {
  it('matches everything when the box is empty or only spaces', () => {
    // The bug this guards is the obvious one written the obvious way: an empty
    // query treated as "matches nothing" blanks the whole picture on first paint.
    expect(matches(node('a'), '', NONE_K, NONE_P)).toBe(true);
    expect(matches(node('a'), '   ', NONE_K, NONE_P)).toBe(true);
  });

  it('looks in the name, kind, path, summary AND section, case-insensitively', () => {
    const n = node('a', { name: 'Deck Assembler', kind: 'renderer', path: 'packages/runtime/src/assemble.ts', summary: 'packages parts', section: 'Runtime Renderer' });
    for (const q of ['deck', 'RENDERER', 'assemble.ts', 'parts', 'runtime rend']) {
      expect(matches(n, q, NONE_K, NONE_P), `should match "${q}"`).toBe(true);
    }
    expect(matches(n, 'nothing here', NONE_K, NONE_P)).toBe(false);
  });

  it('survives a component with no path and no section', () => {
    expect(matches(node('a'), 'thing', NONE_K, NONE_P)).toBe(true);
    expect(matches(node('a'), 'undefined', NONE_K, NONE_P)).toBe(false);
  });

  it('lets a hidden kind or pillar veto a component the query found', () => {
    const n = node('a', { kind: 'build', pillar: 5 });
    expect(matches(n, 'a', new Set(['build']), NONE_P)).toBe(false);
    expect(matches(n, 'a', NONE_K, new Set([5]))).toBe(false);
    expect(matches(n, 'a', new Set(['other']), new Set([1]))).toBe(true);
  });
});

describe('the kind legend', () => {
  it('lists the known kinds in palette order, then anything else the map used', () => {
    // `kind` is a free string in the schema. Dropping "gate" would leave two
    // components counted nowhere and filterable by nothing.
    expect(kindsIn(['gate', 'service', 'entrypoint', 'artifact'])).toEqual(['entrypoint', 'service', 'artifact', 'gate']);
  });

  it('lists nothing for a map with no components', () => {
    expect(kindsIn([])).toEqual([]);
  });

  it('counts by the key it is given, in first-seen order', () => {
    const counts = countBy([node('a'), node('b', { kind: 'build' }), node('c')], (n) => n.kind);
    expect([...counts]).toEqual([['service', 2], ['build', 1]]);
  });
});

describe('the caption rule', () => {
  it('AUTO labels what the map says matters, and everything once zoomed in', () => {
    expect(showsName('auto', 1, 0)).toBe(false);   // an isolated, off-flow leaf
    expect(showsName('auto', 1, 1)).toBe(true);    // one edge or one flow step
    expect(showsName('auto', 2, 0)).toBe(true);    // zoomed in: label it anyway
  });

  it('ALL and OFF ignore both signals', () => {
    expect(showsName('all', 1, 0)).toBe(true);
    expect(showsName('off', 4, 99)).toBe(false);
  });

  it('cycles auto -> all -> off -> auto', () => {
    expect(nextLabelMode('auto')).toBe('all');
    expect(nextLabelMode('all')).toBe('off');
    expect(nextLabelMode('off')).toBe('auto');
  });
});
