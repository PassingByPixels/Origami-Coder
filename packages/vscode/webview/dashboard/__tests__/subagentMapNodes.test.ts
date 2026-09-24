// subagentMapNodes — the agent map's LEFT-TO-RIGHT TREE layout, checked
// without any SVG. t-di35mj replaced the old star (a ring around a centre
// hub) because a fan-out of 20+ filled the ring densely enough that nodes
// overlapped; these cases are the ones a column layout has to get right that
// a ring never had to: no overlap at any roster size, and group order.
import { describe, expect, it } from 'vitest';
import { mapTree, TREE_HUB_X, TREE_NODE_HALF_WIDTH, TREE_NODE_HEIGHT, TREE_MIN_HEIGHT, CARD_LABEL_CLAMP } from '../panes/subagentMapNodes';
import { row } from '../panes/subagentRowFixture';

describe('mapTree — an empty or single-agent roster', () => {
  it('draws nothing for an empty roster, and the panel still fills the old minimum', () => {
    const tree = mapTree([]);
    expect(tree.nodes).toEqual([]);
    expect(tree.height).toBe(TREE_MIN_HEIGHT);
  });

  it('puts a lone agent in its own column, hub levelled to it', () => {
    const tree = mapTree([row()]);
    expect(tree.nodes).toHaveLength(1);
    expect(tree.nodes[0].x).toBe(64);
    expect(tree.hubX).toBe(TREE_HUB_X);
    expect(tree.hubY).toBe(tree.nodes[0].y);
  });
});

describe('mapTree — the column never overlaps, at any roster size', () => {
  it('spaces every consecutive pair by at least one node height', () => {
    const tree = mapTree(Array.from({ length: 25 }, (_, i) => row({ key: `k${i}` })));
    expect(tree.nodes).toHaveLength(25);
    for (let i = 1; i < tree.nodes.length; i++) {
      expect(tree.nodes[i].y - tree.nodes[i - 1].y).toBeGreaterThanOrEqual(TREE_NODE_HEIGHT);
    }
  });

  it('keeps every node inside the fixed 100-unit viewBox WIDTH, at any roster size', () => {
    // Height is free to grow (the panel scrolls to it); width is the one bound
    // the ticket names, and it does not move with the roster.
    const tree = mapTree(Array.from({ length: 25 }, (_, i) => row({ key: `k${i}` })));
    for (const node of tree.nodes) {
      expect(node.x - TREE_NODE_HALF_WIDTH).toBeGreaterThanOrEqual(0);
      expect(node.x + TREE_NODE_HALF_WIDTH).toBeLessThanOrEqual(100);
    }
    expect(tree.hubX).toBeGreaterThanOrEqual(0);
    expect(tree.hubX).toBeLessThanOrEqual(100);
  });

  it('grows the viewBox HEIGHT past the old star\'s square once the column needs it', () => {
    const tree = mapTree(Array.from({ length: 25 }, (_, i) => row({ key: `k${i}` })));
    expect(tree.height).toBeGreaterThan(TREE_MIN_HEIGHT);
    // ...and the last node still fits inside the height it reports.
    expect(tree.nodes[tree.nodes.length - 1].y).toBeLessThan(tree.height);
  });
});

describe('mapTree — group order: Running, then Error, then Done', () => {
  it('reorders a mixed roster into the three bands, oldest-first WITHIN each', () => {
    const tree = mapTree([
      row({ key: 'd1', title: 'done first', state: 'done', settled: true }),
      row({ key: 'r1', title: 'running first', state: 'running' }),
      row({ key: 'e1', title: 'errored first', state: 'error', settled: true }),
      row({ key: 'r2', title: 'running second', state: 'queued' }),
      row({ key: 'd2', title: 'done second', state: 'done', settled: true }),
    ]);
    expect(tree.nodes.map((n) => n.title)).toEqual([
      'running first', 'running second', 'errored first', 'done first', 'done second',
    ]);
    expect(tree.nodes.map((n) => n.group)).toEqual(['running', 'running', 'error', 'done', 'done']);
  });

  it('queued joins Running (still out, not yet working) and failed joins Error (stopped badly)', () => {
    const tree = mapTree([row({ key: 'q', state: 'queued' }), row({ key: 'f', state: 'failed', settled: true })]);
    expect(tree.nodes.map((n) => n.group)).toEqual(['running', 'error']);
  });

  it('an all-running roster draws with no group gap at all — one band, no seam', () => {
    const tree = mapTree([row({ key: 'a' }), row({ key: 'b' }), row({ key: 'c' })]);
    expect(tree.nodes.map((n) => n.group)).toEqual(['running', 'running', 'running']);
  });
});

describe('mapTree — what one node SAYS', () => {
  it('carries the title, model, state, age and token figure, unchanged from the old star', () => {
    const tree = mapTree([
      row({ key: 'c1', title: 'audit the bundle', model: 'openrouter/qwen3-coder', elapsedMs: 125_000, tokens: { input: 12_400, output: 2_100 } }),
    ]);
    expect(tree.nodes[0]).toMatchObject({
      key: 'c1',
      title: 'audit the bundle',
      model: 'openrouter/qwen3-coder',
      state: 'running',
      age: '2m 05s',
      tokens: '14.5k tokens',
      openable: true,
    });
    expect(tree.nodes[0].tokensDetail).toBe('Input 12,400 · Output 2,100');
  });

  it('blanks the model and the tokens the card never carried, and prints neither as zero', () => {
    const tree = mapTree([row({ model: undefined, tokens: undefined, elapsedMs: 0 })]);
    expect(tree.nodes[0].model).toBe('');
    expect(tree.nodes[0].tokens).toBe('');
    expect(tree.nodes[0].age).toBe('');
  });

  it('marks a spawn that never made a child session as NOT openable', () => {
    // There is no transcript behind it — a node that opened an empty page
    // would be worse than one that does not offer to.
    const tree = mapTree([row({ key: 'tc-9', taskSessionId: undefined, state: 'failed' })]);
    expect(tree.nodes[0].openable).toBe(false);
  });

  it('derives the card caption as `<type> · T<n> · <description>`', () => {
    const tree = mapTree([row({ description: 'audit the bundle', agentType: 'scout', ordinal: 3 })]);
    expect(tree.nodes[0].label).toBe('scout · T3 · audit the bundle');
  });

  it('drops the type segment rather than printing it blank when the engine rode none', () => {
    const tree = mapTree([row({ description: 'audit the bundle', ordinal: 2 })]);
    expect(tree.nodes[0].label).toBe('T2 · audit the bundle');
  });

  it('produces the full caption AND the clamp class for a long title — CSS clamps it, this never truncates', () => {
    const long = 'read every wiki page under the personal directory tree and summarise each one in full'.repeat(3);
    const tree = mapTree([row({ description: long, agentType: 'scout', ordinal: 1 })]);
    expect(tree.nodes[0].label).toBe(`scout · T1 · ${long}`);
    expect(CARD_LABEL_CLAMP).toBe('sm-clamp-2');
  });
});
