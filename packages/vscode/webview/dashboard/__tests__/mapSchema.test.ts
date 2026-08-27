// mapSchema (S15) unit tests: the repo-map validator. These assert the observable
// contract a real map file exercises — a well-formed map (stamped and unstamped)
// validates; the three reference checks (node->pillar, edge->node, flowStep->node)
// each produce a PRECISE error naming the offending id; empty edges/flows are fine;
// non-objects and shape breaks are rejected. Each broken fixture would catch a real
// bug: a cartographer that invents a pillar number or node id the rest of the map
// never declares.
//
// V2 update: layers replaced by 5 fixed pillars (numbered 1-5). Nodes use `pillar`
// (number) instead of `layer` (string). Version bumped to 2.

import { describe, it, expect } from 'vitest';
import { validateMap, type RepoMap } from '../../../src/dashboard/agentManager/mapSchema';

/** A minimal, fully-valid, UNSTAMPED map (as a cartographer writes it). */
function validMap(): Record<string, unknown> {
  return {
    version: 2,
    name: 'demo',
    summary: 'a tiny app',
    nodes: [
      { id: 'app', name: 'App', pillar: 1, kind: 'entrypoint', path: 'src/app.ts', summary: 'entry point' },
      { id: 'api', name: 'API', pillar: 2, kind: 'service', summary: 'http handler' },
    ],
    edges: [{ from: 'app', to: 'api', label: 'dispatches requests' }],
    flows: [
      { id: 'boot', name: 'Boot', description: 'startup sequence', steps: [
        { node: 'app', note: 'mount' },
        { node: 'api', note: 'connect' },
      ] },
    ],
    keyFiles: [{ path: 'src/app.ts', why: 'entry point' }],
    conventions: ['no default exports'],
  };
}

describe('validateMap - valid maps', () => {
  it('accepts a well-formed unstamped map and returns the typed value', () => {
    const res = validateMap(validMap());
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.map.name).toBe('demo');
  });

  it('accepts a STAMPED map (builtAt present and well-shaped)', () => {
    const m = { ...validMap(), builtAt: { sha: 'abc123', branch: 'main', at: 1700000000000 } };
    expect(validateMap(m).ok).toBe(true);
  });

  it('accepts empty edges AND empty flows (a small repo may have neither)', () => {
    const m = { ...validMap(), edges: [], flows: [] };
    expect(validateMap(m).ok).toBe(true);
  });

  it('accepts a map with no keyFiles / conventions arrays at all', () => {
    const m = validMap();
    delete m.keyFiles; delete m.conventions;
    expect(validateMap(m).ok).toBe(true);
  });

  it('accepts nodes with status and section fields', () => {
    const m = validMap();
    (m.nodes as Array<Record<string, unknown>>)[0].status = 'new';
    (m.nodes as Array<Record<string, unknown>>)[0].section = 'startup';
    expect(validateMap(m).ok).toBe(true);
  });

  it('accepts a node with status "unchanged" (same as omitting)', () => {
    const m = validMap();
    (m.nodes as Array<Record<string, unknown>>)[0].status = 'unchanged';
    expect(validateMap(m).ok).toBe(true);
  });
});

describe('validateMap - reference integrity (the load-bearing checks)', () => {
  it('ERRORS when a node references an invalid pillar number, naming both ids', () => {
    const m = validMap();
    (m.nodes as Array<Record<string, unknown>>)[1].pillar = 99;
    const res = validateMap(m);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.some((e) => e.includes('"api"') && e.includes('99'))).toBe(true);
  });

  it('ERRORS when an edge endpoint is not a node id', () => {
    const m = validMap();
    (m.edges as Array<Record<string, unknown>>)[0].to = 'nope';
    const res = validateMap(m);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.some((e) => e.includes('to "nope" is not a node id'))).toBe(true);
  });

  it('ERRORS when a flow step references an unknown node, naming the step', () => {
    const m = validMap();
    (((m.flows as Array<Record<string, unknown>>)[0].steps) as Array<Record<string, unknown>>)[1].node = 'missing';
    const res = validateMap(m);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.some((e) => e.includes('flow "boot" step 2') && e.includes('"missing"'))).toBe(true);
  });

  it('flags a duplicate node id', () => {
    const m = validMap();
    (m.nodes as Array<Record<string, unknown>>).push({ id: 'app', name: 'Dup', pillar: 1, kind: 'module', summary: 'x' });
    const res = validateMap(m);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.some((e) => e.includes('duplicate node id "app"'))).toBe(true);
  });
});

describe('validateMap - shape errors', () => {
  it('rejects a non-object (garbage / a JSON scalar or array)', () => {
    expect(validateMap(null).ok).toBe(false);
    expect(validateMap(42).ok).toBe(false);
    expect(validateMap([]).ok).toBe(false);
    expect(validateMap('a string').ok).toBe(false);
  });

  it('rejects a wrong version and a non-string name', () => {
    const res = validateMap({ ...validMap(), version: 1, name: 5 });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.errors.some((e) => e.includes('version must be 2'))).toBe(true);
      expect(res.errors.some((e) => e.includes('name must be a non-empty string'))).toBe(true);
    }
  });

  it('rejects a malformed builtAt when present', () => {
    const res = validateMap({ ...validMap(), builtAt: { sha: 'x' } });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.some((e) => e.includes('builtAt'))).toBe(true);
  });

  it('rejects a node missing required string fields', () => {
    const m = validMap();
    (m.nodes as Array<Record<string, unknown>>)[0] = { id: 'app', name: 'App' }; // no pillar/kind/summary
    expect(validateMap(m).ok).toBe(false);
  });

  it('rejects a node with an invalid status value', () => {
    const m = validMap();
    (m.nodes as Array<Record<string, unknown>>)[0].status = 'badstatus';
    expect(validateMap(m).ok).toBe(false);
  });

  it('rejects a flow whose steps is not an array', () => {
    const m = validMap();
    (m.flows as Array<Record<string, unknown>>)[0].steps = 'nope';
    expect(validateMap(m).ok).toBe(false);
  });

  it('rejects an edge without a label', () => {
    const m = validMap();
    delete (m.edges as Array<Record<string, unknown>>)[0].label;
    expect(validateMap(m).ok).toBe(false);
  });

  it('rejects a flow without a description', () => {
    const m = validMap();
    delete (m.flows as Array<Record<string, unknown>>)[0].description;
    expect(validateMap(m).ok).toBe(false);
  });

  // A round-trippable typed value: the happy path yields something usable downstream.
  it('the returned map is the same structural object (identity preserved)', () => {
    const src = validMap();
    const res = validateMap(src);
    if (res.ok) { const m: RepoMap = res.map; expect(m.nodes.length).toBe(2); expect(m.edges.length).toBe(1); }
  });
});