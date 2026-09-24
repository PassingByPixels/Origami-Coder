// ledgerRows.ts — the sub-agent ledger's arithmetic, with no DOM anywhere near
// it (t-f1j2y3). The lock rules are the reason this file exists: a locked cell
// looks identical to a settable one in a screenshot, and the nesting lock is
// DERIVED from a state rather than read from a flag, so it is exactly the kind
// of rule that goes quietly wrong.

import { describe, expect, it } from 'vitest';
import {
  groupBySource, workspaceState, cellState, cellLock, workspaceLock,
  nextState, onCount, columnNext, NESTING_TOOLS,
  type LedgerAgent, type LedgerTool,
} from '../panes/ledgerRows';

const tool = (id: string, over: Partial<LedgerTool> = {}): LedgerTool => ({
  id,
  description: `${id} does a thing`,
  deferred: false,
  disabled: false,
  source: 'builtin',
  hardRequired: false,
  ...over,
});

const agent = (name: string, states: Record<string, string>): LedgerAgent => ({
  agent: name,
  native: false,
  states,
});

describe('ledgerRows — grouping', () => {
  it('puts the groups in a FIXED order, whatever order the tools arrive in', () => {
    const tools = [tool('z', { source: 'user-file' }), tool('a'), tool('m', { source: 'plugin' })];

    expect(groupBySource(tools).map((g) => [g.source, g.label, g.tools.map((t) => t.id)])).toEqual([
      ['builtin', 'builtin', ['a']],
      ['plugin', 'plugin', ['m']],
      ['user-file', 'user file', ['z']],
    ]);
  });

  it('drops a group with nothing in it, so a search never leaves an empty heading', () => {
    expect(groupBySource([tool('a')]).map((g) => g.source)).toEqual(['builtin']);
  });

  it('keeps the order inside a group — the engine sorted it, the filter only narrowed it', () => {
    const tools = [tool('read'), tool('bash'), tool('write')];

    expect(groupBySource(tools)[0]!.tools.map((t) => t.id)).toEqual(['read', 'bash', 'write']);
  });

  it('has nothing to draw for an empty list', () => {
    expect(groupBySource([])).toEqual([]);
  });
});

describe('ledgerRows — what a cell says', () => {
  it('reads OFF ahead of DEFERRED for the workspace column, the order the engine takes them in', () => {
    expect(workspaceState(tool('a', { disabled: true, deferred: true }))).toBe('off');
    expect(workspaceState(tool('a', { deferred: true }))).toBe('deferred');
    expect(workspaceState(tool('a'))).toBe('loaded');
  });

  it('falls back to loaded for a tool an older engine row says nothing about', () => {
    const row = agent('general', { read: 'off' });

    expect(cellState(row, 'read')).toBe('off');
    expect(cellState(row, 'a_tool_added_since')).toBe('loaded');
    // A state the row invented is not one of the three either.
    expect(cellState(agent('general', { read: 'maybe' }), 'read')).toBe('loaded');
  });
});

describe('ledgerRows — which cells cannot be clicked', () => {
  it('locks a hard-required tool in every column, workspace included', () => {
    const search = tool('tool_search', { hardRequired: true });

    expect(cellLock(search, 'loaded')).toContain('always registered');
    expect(workspaceLock(search)).toContain('always registered');
  });

  it('locks a peer tool ONLY where the engine reports it off', () => {
    // Off means the agent's own definition did not name it, which is the one
    // case no config write can move. An agent that DOES name it comes back
    // loaded or deferred, and that cell stays live.
    for (const id of NESTING_TOOLS) {
      expect(cellLock(tool(id), 'off')).toContain('own agent definition names it');
      expect(cellLock(tool(id), 'loaded')).toBeNull();
      expect(cellLock(tool(id), 'deferred')).toBeNull();
    }
  });

  it('does not lock an ordinary tool that is merely off', () => {
    expect(cellLock(tool('read'), 'off')).toBeNull();
  });

  it('never locks the workspace column for a peer tool — that setting is the workspace own', () => {
    expect(workspaceLock(tool('task'))).toBeNull();
  });

  // t-h8s3xg. The engine now says WHY a spawning tool is off for a child while
  // `subagent_depth` is 1, because `off` on its own reads as a setting the
  // user may cycle and this one they may not.
  it('prints the engine’s own reason, and locks the cell, whatever state it reports', () => {
    const row: LedgerAgent = {
      agent: 'general',
      native: true,
      states: { task: 'off', read: 'loaded' },
      unavailable: { task: 'nested sub-agents need subagent_depth ≥ 2' },
    };

    expect(cellLock(tool('task'), 'off', row)).toBe(
      'task is unavailable here: nested sub-agents need subagent_depth ≥ 2.',
    );
    // A stale `loaded` from a pending override cannot unlock it: the reason is
    // a fact about the cell, not a reading of its state.
    expect(cellLock(tool('task'), 'loaded', row)).toContain('subagent_depth');
    // Nothing else on the row is touched.
    expect(cellLock(tool('read'), 'loaded', row)).toBeNull();
  });

  it('leaves every cell as it was when the engine sends no reasons (older engine)', () => {
    const row = agent('general', { task: 'loaded' });

    expect(cellLock(tool('task'), 'loaded', row)).toBeNull();
    expect(cellLock(tool('task'), 'off', row)).toContain('own agent definition names it');
  });

  it('a column whose only settable cells are unavailable offers no column click', () => {
    // `task_list` is not one of NESTING_TOOLS, so nothing but the engine's own
    // reason can lock this cell - which is what makes the assertion mean
    // something.
    const states = { task_list: 'off' };
    const free: LedgerAgent = { agent: 'general', native: true, states };
    const locked: LedgerAgent = {
      ...free,
      unavailable: { task_list: 'nested sub-agents need subagent_depth ≥ 2' },
    };

    expect(columnNext(free, [tool('task_list')])).toBe('loaded');
    expect(columnNext(locked, [tool('task_list')])).toBeNull();
  });
});

describe('ledgerRows — the cycle', () => {
  it('goes loaded to deferred to off and back round', () => {
    expect(nextState('loaded')).toBe('deferred');
    expect(nextState('deferred')).toBe('off');
    expect(nextState('off')).toBe('loaded');
  });

  it('steps over deferred for a tool that cannot be deferred', () => {
    expect(nextState('loaded', false)).toBe('off');
    expect(nextState('off', false)).toBe('loaded');
    // Already there by some other route: the next click still leaves.
    expect(nextState('deferred', false)).toBe('off');
  });
});

describe('ledgerRows — the header numbers and the column click', () => {
  const tools = [tool('read'), tool('write'), tool('task')];

  it('counts every tool this agent actually gets — deferred counts as ON', () => {
    expect(onCount(agent('a', { read: 'loaded', write: 'deferred', task: 'off' }), tools)).toBe(2);
    expect(onCount(agent('a', {}), tools)).toBe(3);
    expect(onCount(agent('a', { read: 'off', write: 'off', task: 'off' }), tools)).toBe(0);
  });

  it('takes the column click from the FIRST settable cell, not the first cell', () => {
    // read is locked here, so the column follows write (deferred -> off).
    const locked = [tool('read', { hardRequired: true }), tool('write'), tool('task')];

    expect(columnNext(agent('a', { read: 'loaded', write: 'deferred' }), locked)).toBe('off');
  });

  it('skips a peer tool that is off when choosing the column state', () => {
    expect(columnNext(agent('a', { task: 'off', read: 'off' }), [tool('task'), tool('read')])).toBe('loaded');
  });

  it('has nothing to set when every cell in the column is locked', () => {
    expect(columnNext(agent('a', { task: 'off' }), [tool('task')])).toBeNull();
    expect(columnNext(agent('a', {}), [])).toBeNull();
  });
});
