// t-z1xlfy — the agent map's layout model: a column per tier, a child on its
// parent's row, rounded elbows that join at the parent, chips after their owner,
// extents that scroll, and the 89-agent big map.
import { describe, expect, it } from 'vitest';
import { row } from './subagentRowFixture';
import type { RosterRow } from './chatHistory';
import { agentTree, chatShells, HUB, taskEnd, type AgentTreeView, type TreeTask } from './agentTree';
import {
  CARD_H, CARD_W, CHIP_H, COL0, COL_W, HUB_W, LEAD, TOP, GAP, ZOOM_MIN,
  chainOf, elbowPath, fitZoom, layoutMap, scrollAround, type MapItem,
} from './agentMapLayout';
import type { SubagentRow } from './subagentRows';

const X1 = COL0 + HUB_W + LEAD;
const agent = (key: string, parent: string, depth: number, state: SubagentRow['state'] = 'done') =>
  ({ row: row({ key, taskSessionId: key, state, settled: state !== 'running' }), parent, depth });
const task = (key: string, owner: string, status: TreeTask['status'] = 'running'): TreeTask => ({ key, owner, title: key, status, startedAt: 0 });
const at = (items: MapItem[], key: string) => items.find((i) => i.key === key)!;
const roster = (id: string, parentId: string, depth: number, over: Partial<RosterRow> = {}): RosterRow => ({
  id, parentId, depth, title: `job ${id}`, agent: 'explore', status: 'idle', created: 1000, updated: 61000,
  tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }, cost: 0, steps: null, context: null, ...over,
});

describe('layoutMap — tiers and rows', () => {
  const tree: AgentTreeView = {
    agents: [agent('T1', HUB, 1), agent('T1.1', 'T1', 2), agent('T1.2', 'T1', 2), agent('T1.1.1', 'T1.1', 3), agent('T2', HUB, 1)],
    tasks: [],
  };
  const { items } = layoutMap(tree);

  it('puts each tier in its own column', () => {
    expect(at(items, 'T1').x).toBe(X1);
    expect(at(items, 'T1.1').x).toBe(X1 + COL_W);
    expect(at(items, 'T1.1.1').x).toBe(X1 + 2 * COL_W);
  });

  it('starts a first child on its parent\'s row, and a later child on the next free row', () => {
    expect(at(items, 'T1.1').y).toBe(at(items, 'T1').y);
    expect(at(items, 'T1.1.1').y).toBe(at(items, 'T1.1').y);
    expect(at(items, 'T1.2').y).toBe(TOP + CARD_H + GAP);
    // T2 goes below the whole of T1's subtree, never beside it.
    expect(at(items, 'T2').y).toBe(at(items, 'T1.2').y + CARD_H + GAP);
  });

  it('lists top-level agents Running, Failed, Done', () => {
    const { items: mixed } = layoutMap({ agents: [agent('a', HUB, 1, 'done'), agent('b', HUB, 1, 'failed'), agent('c', HUB, 1, 'running')], tasks: [] });
    expect([...mixed].sort((p, q) => p.y - q.y).map((i) => i.key)).toEqual(['c', 'b', 'a']);
  });
});

describe('layoutMap — wires', () => {
  const { items, hub } = layoutMap({ agents: [agent('T1', HUB, 1), agent('T1.1', 'T1', 2), agent('T1.2', 'T1', 2), agent('T1.3', 'T1', 2)], tasks: [] });

  it('a child on its parent\'s row gets a straight wire', () => {
    expect(at(items, 'T1.1').path).toBe(`M${X1 + CARD_W},${TOP + 16} H${X1 + COL_W}`);
  });

  it('every other child joins its parent at ONE point, down one trunk, with rounded corners', () => {
    const start = `M${X1 + CARD_W},${TOP + 16} H${X1 + CARD_W + 18 - 6} Q${X1 + CARD_W + 18},${TOP + 16}`;
    expect(at(items, 'T1.2').path.startsWith(start)).toBe(true);
    expect(at(items, 'T1.3').path.startsWith(start)).toBe(true);
    expect(at(items, 'T1.3').path).toContain(` V${at(items, 'T1.3').y + 16 - 6} `);
    expect(at(items, 'T1.3').path.endsWith(` H${X1 + COL_W}`)).toBe(true);
  });

  it('a top-level card wires from the hub\'s right edge', () => {
    expect(at(items, 'T1').path.startsWith(`M${COL0 + HUB_W},${TOP + 22} `)).toBe(true);
  });

  it('an upward elbow bends the other way', () => {
    expect(elbowPath(0, 100, 50, 40)).toBe('M0,100 H12 Q18,100 18,94 V46 Q18,40 24,40 H50');
  });

  it('a wire takes its card\'s group; a failed one is `failed`', () => {
    const { items: f } = layoutMap({ agents: [agent('x', HUB, 1, 'error')], tasks: [] });
    expect(f[0].wire).toBe('failed');
  });
});

describe('layoutMap — background chips', () => {
  const { items } = layoutMap({
    agents: [agent('T4', HUB, 1, 'running'), agent('T4.1', 'T4', 2), agent('T5', HUB, 1, 'failed')],
    tasks: [task('B4', 'T4'), task('B5', 'T5', 'cancelled'), task('B1', HUB)],
  });

  it('a chip sits after its owner\'s sub-agents, one tier right of the owner', () => {
    expect(at(items, 'B4').x).toBe(X1 + COL_W);
    expect(at(items, 'B4').y).toBe(at(items, 'T4.1').y + CARD_H + GAP);
    expect(at(items, 'B4').h).toBe(CHIP_H);
    expect(at(items, 'B4').wire).toBe('bg');
  });

  it('an owner with no sub-agents has its first chip on its own row', () => {
    expect(at(items, 'B5').y).toBe(at(items, 'T5').y);
  });

  it('the chat\'s own chips come last, in tier 1', () => {
    const last = [...items].sort((a, b) => a.y - b.y).pop()!;
    expect(last.key).toBe('B1');
    expect(last.x).toBe(X1);
  });
});

describe('layoutMap — extents, zoom and the big map', () => {
  // The mockup's big map: T1..T5 plus five agents spawning 4 tiers deep (3, 2, 1 children).
  const agents: ReturnType<typeof agent>[] = [];
  let n = 0;
  const add = (id: string, parent: string, depth: number) => {
    const s = n % 11 === 3 ? 'running' : n % 13 === 5 ? 'failed' : 'done';
    n++;
    agents.push(agent(id, parent, depth, s));
    if (depth < 4) for (let c = 1; c <= (depth === 1 ? 3 : depth === 2 ? 2 : 1); c++) add(`${id}.${c}`, id, depth + 1);
  };
  for (let i = 1; i <= 8; i++) add(`T${i}`, HUB, 1);
  const layout = layoutMap({ agents, tasks: [task('B1', HUB), task('B2', 'T3')] });

  it('holds 80+ agents in 4 tiers with no two boxes overlapping', () => {
    expect(agents.length).toBeGreaterThanOrEqual(80);
    expect(layout.tiers).toBe(4);
    const boxes = layout.items;
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i], b = boxes[j];
        const overlap = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
        expect(overlap, `${a.key} overlaps ${b.key}`).toBe(false);
      }
    }
  });

  it('the world covers every box, so both scrollbars reach everything', () => {
    for (const it of layout.items) {
      expect(it.x + it.w).toBeLessThanOrEqual(layout.width);
      expect(it.y + it.h).toBeLessThanOrEqual(layout.height);
    }
    expect(layout.width).toBe(X1 + 3 * COL_W + CARD_W + 24);
  });

  it('Fit shrinks a big map into the view and never zooms a small one past 100 %', () => {
    const z = fitZoom(900, 500, layout.width, layout.height);
    expect(z).toBeLessThan(1);
    expect(z).toBeGreaterThanOrEqual(ZOOM_MIN);
    expect(layout.height * z).toBeLessThanOrEqual(500 - 16 + 0.001);
    expect(fitZoom(2000, 2000, 400, 300)).toBe(1);
  });

  it('a zoom around a point keeps that point under the pointer', () => {
    const s = scrollAround({ left: 100, top: 50 }, { x: 200, y: 120 }, 1, 2);
    // world point under the pointer: (100 + 200) / 1 = 300 before; (s.left + 200) / 2 after.
    expect((s.left + 200) / 2).toBe(300);
    expect((s.top + 120) / 2).toBe(170);
  });

  it('an empty map still has room for the hub', () => {
    const empty = layoutMap({ agents: [], tasks: [] });
    expect(empty.items).toEqual([]);
    expect(empty.height).toBeGreaterThanOrEqual(TOP + 62);
  });

  it('hover keeps the chain from a grandchild up to the chat', () => {
    expect([...chainOf(layout.items, 'T3.1.1')].sort()).toEqual(['T3', 'T3.1', 'T3.1.1']);
  });
});

describe('agentTree — the tree off three sources', () => {
  const direct = [row({ key: 'k1', taskSessionId: 'k1', ordinal: 1 }), row({ key: 'k3', taskSessionId: 'k3', ordinal: 3 })];

  it('hangs roster rows under their parent and numbers them from it', () => {
    const view = agentTree(direct, {
      rows: [roster('k3', 'root', 1), roster('g1', 'k3', 2), roster('g2', 'k3', 2), roster('gg', 'g1', 3, { status: 'running', created: 1000 })],
      background: [],
    }, [], 31000);
    const byKey = new Map(view.agents.map((a) => [a.row.key, a]));
    expect(byKey.get('g1')).toMatchObject({ parent: 'k3', depth: 2, row: { short: 'T3.1', state: 'done', description: 'job g1', agentType: 'explore' } });
    expect(byKey.get('g2')?.row.short).toBe('T3.2');
    expect(byKey.get('gg')).toMatchObject({ parent: 'g1', depth: 3, row: { short: 'T3.1.1', state: 'running', elapsedMs: 30000, settled: false } });
    expect(view.agents.filter((a) => a.depth === 1).map((a) => a.row.key)).toEqual(['k1', 'k3']); // depth-1 roster rows never double a card
  });

  it('drops a row whose parent is not on the map, with its branch', () => {
    const view = agentTree(direct, { rows: [roster('x', 'dismissed', 2), roster('xx', 'x', 3)], background: [] }, [], 0);
    expect(view.agents.map((a) => a.row.key)).toEqual(['k1', 'k3']);
  });

  it('hangs a sub-agent\'s background shell on it, and an unknown owner\'s on the chat', () => {
    const view = agentTree(direct, { rows: [], background: [
      { ownerSessionId: 'k1', jobId: 'j1', title: 'watch', status: 'running', startedAt: 5 },
      { ownerSessionId: 'gone', jobId: 'j2', title: 'tail', status: 'running', startedAt: 5 },
    ] }, [], 0);
    expect(view.tasks.map((t) => [t.key, t.owner])).toEqual([['j1', 'k1'], ['j2', HUB]]);
  });

  it('reads the chat\'s own background shells off their bash cards', () => {
    const shells = chatShells([
      { toolName: 'bash', toolStatus: 'in_progress', toolShell: { state: 'background', jobId: 'shell-a', command: 'bun run dev', startedAt: 7 } },
      { toolName: 'bash', toolStatus: 'failed', toolShell: { state: 'promoted', jobId: 'job-b', command: 'npm test', exit: null } },
      { toolName: 'bash', toolStatus: 'completed', toolShell: { state: 'foreground', command: 'ls' } },
      { toolName: 'task', toolStatus: 'in_progress' },
    ]);
    expect(shells.map((s) => [s.key, s.owner, s.title, s.status])).toEqual([['shell-a', HUB, 'bun run dev', 'running'], ['job-b', HUB, 'npm test', 'cancelled']]);
  });

  it('a chip prints its ticking age while it runs, and "stopped with Tn" when its owner took it down', () => {
    const age = (ms: number) => `${ms / 1000}s`;
    expect(taskEnd(task('b', 'k1'), undefined, 9000, age)).toBe('9s');
    expect(taskEnd(task('b', 'k5', 'cancelled'), row({ ordinal: 5, settled: true, state: 'failed' }), 0, age)).toBe('stopped with T5');
    expect(taskEnd(task('b', HUB, 'cancelled'), undefined, 0, age)).toBe('stopped');
    expect(taskEnd(task('b', HUB, 'completed'), undefined, 0, age)).toBe('ended');
  });
});

describe('the agentTree wire', () => {
  it('asks the host for this chat\'s tree, and takes only this chat\'s answer', async () => {
    const { watchAgentTree } = await import('./agentTree');
    const posted: unknown[] = [];
    let handler: (msg: unknown) => void = () => {};
    const got: unknown[] = [];
    const stop = watchAgentTree({ sessionId: 'chat-1', post: (m) => posted.push(m), listen: (h) => { handler = h; return () => {}; }, onTree: (t) => got.push(t) });
    expect(posted).toEqual([{ type: 'agentTreeRequest', sessionId: 'chat-1' }]);
    handler({ type: 'agentTree', sessionId: 'chat-2', rows: [roster('a', 'r', 1)], background: [] });
    handler({ type: 'agentTree', sessionId: 'chat-1', rows: [roster('b', 'r', 1)], background: [] });
    expect(got).toEqual([{ rows: [roster('b', 'r', 1)], background: [] }]);
    stop();
  });
});

describe('mapHubLine', () => {
  it('names the tiers and the running background tasks when there are any', async () => {
    const { mapHubLine } = await import('./agentMapLayout');
    const rows = [row({ tokens: { input: 1000, output: 500 } }), row({ key: 'b' })];
    expect(mapHubLine(rows, 3, 2)).toBe('This chat · 2 sub-agents in 3 tiers · 2 background · 1.5k tokens');
    expect(mapHubLine(rows.slice(1), 1, 0)).toBe('This chat · 1 sub-agent');
  });
});
