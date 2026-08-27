// subagentRows — which sub-agents this chat still has out.
//
// The derivation is the feature: everything comes from the `task` tool cards
// the transcript already holds, so the drawer cannot disagree with the card it
// was read from. What can go wrong is the bookkeeping — a resumed agent counted
// twice, a finished one left listed, an unfamiliar status silently dropping a
// run nobody is then watching.

import { describe, expect, it } from 'vitest';
import { groupSubagents, subagentRows, type SubagentMessage } from './subagentRows';

const NOW = 1_700_000_100_000;
const card = (over: Partial<SubagentMessage> = {}): SubagentMessage => ({
  taskSessionId: 'child-1',
  label: 'task: audit the bundle',
  toolStatus: 'in_progress',
  timestamp: NOW - 5_000,
  ...over,
});

describe('subagentRows — who is still out', () => {
  it('lists an in-progress task card as running, with its age', () => {
    expect(subagentRows([card()], NOW)).toEqual([
      {
        key: 'child-1',
        taskSessionId: 'child-1',
        title: 'task: audit the bundle',
        state: 'running',
        elapsedMs: 5_000,
        model: undefined,
        activity: '',
      },
    ]);
  });

  it('a pending card is QUEUED — accepted but not started is not running', () => {
    expect(subagentRows([card({ toolStatus: 'pending' })], NOW)[0].state).toBe('queued');
  });

  it('SETTLES completed and failed agents rather than dropping them', () => {
    // Was `toEqual(['c'])`: a settled agent used to leave the roster entirely.
    // The contract widened when the Complete group landed — see the group
    // describe below and subagentEntry.ts's `entryState`.
    const rows = subagentRows([
      card({ taskSessionId: 'a', toolStatus: 'completed' }),
      card({ taskSessionId: 'b', toolStatus: 'failed' }),
      card({ taskSessionId: 'c', toolStatus: 'in_progress' }),
    ], NOW);
    expect(rows.map((r) => [r.taskSessionId, r.state]))
      .toEqual([['a', 'done'], ['b', 'error'], ['c', 'running']]);
  });

  it('ignores every message that is not a sub-agent card', () => {
    // Ordinary tool calls and prose have no taskSessionId and must not appear.
    const rows = subagentRows([
      { label: 'read', toolStatus: 'in_progress' },
      { taskSessionId: '', label: 'write', toolStatus: 'in_progress' },
      card(),
    ], NOW);
    expect(rows).toHaveLength(1);
  });

  it('a RESUMED agent is ONE row, carrying its latest status', () => {
    // The model can resume a sub-agent, which writes a second card for the same
    // session. Two rows would claim two agents are out when one is — and the
    // LAST card is the one whose status is current.
    const rows = subagentRows([
      card({ toolStatus: 'in_progress', timestamp: NOW - 60_000 }),
      card({ toolStatus: 'completed', timestamp: NOW - 1_000 }),
    ], NOW);
    // One row, settled — the later card wins. (Was `toEqual([])` before a
    // settled agent kept its row; the DEDUPE claim is what this asserts.)
    expect(rows).toHaveLength(1);
    expect(rows[0].state).toBe('done');

    const stillOut = subagentRows([
      card({ toolStatus: 'completed', timestamp: NOW - 60_000 }),
      card({ toolStatus: 'in_progress', timestamp: NOW - 1_000 }),
    ], NOW);
    expect(stillOut).toHaveLength(1);
    expect(stillOut[0].elapsedMs).toBe(1_000);
  });

  it('an UNKNOWN status is treated as still out, not silently dropped', () => {
    // A run wrongly listed is a visible annoyance; one silently missing is a
    // sub-agent nobody is watching. The list is of terminal states, on purpose.
    expect(subagentRows([card({ toolStatus: 'throttled' })], NOW)).toHaveLength(1);
    expect(subagentRows([card({ toolStatus: undefined })], NOW)).toHaveLength(1);
  });

  it('falls back to the session id when the card has no label', () => {
    // Addressable beats decorative — never a placeholder like "(sub-agent)".
    expect(subagentRows([card({ label: '' })], NOW)[0].title).toBe('child-1');
    expect(subagentRows([card({ label: '   ' })], NOW)[0].title).toBe('child-1');
  });

  it('reports NO age rather than a fake one when the card has no timestamp', () => {
    expect(subagentRows([card({ timestamp: undefined })], NOW)[0].elapsedMs).toBe(0);
  });

  it('never reports a negative age when the clocks disagree', () => {
    expect(subagentRows([card({ timestamp: NOW + 30_000 })], NOW)[0].elapsedMs).toBe(0);
  });

  it('keeps arrival order, oldest first', () => {
    const rows = subagentRows([
      card({ taskSessionId: 'first' }),
      card({ taskSessionId: 'second' }),
      card({ taskSessionId: 'third' }),
    ], NOW);
    expect(rows.map((r) => r.taskSessionId)).toEqual(['first', 'second', 'third']);
  });

  it('an empty transcript yields nothing at all', () => {
    expect(subagentRows([], NOW)).toEqual([]);
  });
});

// The lifecycle bug this whole feature exists to fix. The extension always
// launches the engine with background sub-agents ON, so a `task` call returns —
// and its card completes — moments after the child is SPAWNED, minutes before
// the child finishes. Retiring the row on that status emptied the drawer while
// every agent was still working.
describe('subagentRows — a BACKGROUND child outlives its launcher card', () => {
  const bg = (over: Partial<SubagentMessage> = {}) => card({ taskBackground: true, ...over });

  it('keeps the row when the launcher card COMPLETES — that only means "spawned"', () => {
    const rows = subagentRows([bg({ toolStatus: 'completed' })], NOW);
    expect(rows).toHaveLength(1);
    expect(rows[0].state).toBe('running');
  });

  // CONTRACT CHANGE (Complete group): a settled child used to leave the roster
  // — `entryState` returned undefined and the row was skipped. It now returns a
  // TERMINAL state instead, because a row that disappears is a run nobody can
  // go back and read. These three assertions pinned the old behaviour and were
  // updated deliberately, not because they broke.
  it('marks it done on the engine terminal marker, and says HOW it ended', () => {
    expect(subagentRows([bg({ toolStatus: 'completed', taskDone: 'completed' })], NOW)[0].state).toBe('done');
    expect(subagentRows([bg({ toolStatus: 'completed', taskDone: 'error' })], NOW)[0].state).toBe('error');
  });

  it('a FOREGROUND child is unchanged — its card blocks until the child returns', () => {
    // No marker is ever sent for one, so reading `taskDone` for every row would
    // have left every foreground agent listed forever.
    expect(subagentRows([card({ toolStatus: 'completed' })], NOW)[0].state).toBe('done');
    expect(subagentRows([card({ toolStatus: 'failed' })], NOW)[0].state).toBe('error');
    expect(subagentRows([card({ toolStatus: 'in_progress' })], NOW)[0].state).toBe('running');
  });

  it('a marker for a DIFFERENT child settles only that one', () => {
    const rows = subagentRows([
      bg({ taskSessionId: 'a', toolStatus: 'completed', taskDone: 'completed' }),
      bg({ taskSessionId: 'b', toolStatus: 'completed' }),
    ], NOW);
    expect(rows.map((r) => [r.taskSessionId, r.state])).toEqual([['a', 'done'], ['b', 'running']]);
  });
});

// The reason the contract widened. A sub-agent's whole value is what it did,
// and that is only readable AFTER it finishes — so the one moment the drawer
// used to go blank was the one moment you wanted it.
describe('subagentRows — a finished sub-agent keeps its row', () => {
  it('a settled child is still listed, with a terminal state', () => {
    const rows = subagentRows([card({ taskBackground: true, toolStatus: 'completed', taskDone: 'completed' })], NOW);
    expect(rows).toHaveLength(1);
    expect(rows[0].taskSessionId).toBe('child-1');
    expect(rows[0].state).toBe('done');
  });

  it('groups the live ones apart from the finished ones, oldest first', () => {
    const rows = subagentRows([
      card({ taskSessionId: 'a', toolStatus: 'completed' }),
      card({ taskSessionId: 'b', toolStatus: 'in_progress' }),
      card({ taskSessionId: 'c', toolStatus: 'pending' }),
      card({ taskSessionId: 'd', toolStatus: 'failed' }),
    ], NOW);
    const { running, complete } = groupSubagents(rows);
    expect(running.map((r) => r.key)).toEqual(['b', 'c']);
    expect(complete.map((r) => r.key)).toEqual(['a', 'd']);
  });

  it('partitions — every row lands in exactly one group, none in neither', () => {
    // The whole point of the negative side: a state nobody classified shows up
    // under Complete, which is wrong but visible. A row in NEITHER group is a
    // sub-agent the drawer silently forgot, which is the defect this replaced.
    const rows = subagentRows([
      card({ taskSessionId: 'a', toolStatus: 'in_progress' }),
      card({ taskSessionId: 'b', toolStatus: 'completed' }),
      { label: 'denied', toolName: 'task', toolStatus: 'failed', toolCallId: 'tc-9' },
    ], NOW);
    const { running, complete } = groupSubagents(rows);
    expect(running.length + complete.length).toBe(rows.length);
    expect([...running, ...complete].map((r) => r.key).sort()).toEqual(['a', 'b', 'tc-9']);
  });
});

// The spawn that never happened. A denied `task` permission and an unknown
// agent type both fail in the engine BEFORE a child session exists (see
// src/tool/task.ts), so no session id is ever stamped on the card. Keyed on
// that id alone, the drawer showed NOTHING for either — a fan-out of five with
// one denied listed four and gave no hint a fifth had been asked for.
describe('subagentRows — a spawn that never produced a child', () => {
  const denied = (over: Partial<SubagentMessage> = {}): SubagentMessage => ({
    label: 'task: audit the bundle',
    toolName: 'task',
    toolCallId: 'tc-1',
    toolStatus: 'failed',
    timestamp: NOW - 5_000,
    ...over,
  });

  it('lists a FAILED task card that never got a session id, keyed by the card', () => {
    expect(subagentRows([denied()], NOW)).toEqual([
      {
        key: 'tc-1',
        // No child was created, so there is no session to name — and nothing
        // to go and look at. Saying so beats printing the tool call id here.
        taskSessionId: undefined,
        title: 'task: audit the bundle',
        state: 'failed',
        elapsedMs: 5_000,
        model: undefined,
        activity: '',
      },
    ]);
  });

  it('shows the refused spawn ALONGSIDE the siblings that did start', () => {
    const rows = subagentRows([
      card({ taskSessionId: 'child-1' }),
      denied({ toolCallId: 'tc-2' }),
      card({ taskSessionId: 'child-2' }),
    ], NOW);
    expect(rows.map((r) => [r.key, r.state])).toEqual([
      ['child-1', 'running'],
      ['tc-2', 'failed'],
      ['child-2', 'running'],
    ]);
  });

  it('is NOT listed while the call is still in flight — only once it failed', () => {
    // Every spawn is anonymous for a moment: the engine stamps the id only once
    // the child session exists. A row put up then would be keyed by the tool
    // call and re-keyed seconds later by the session that replaced it.
    expect(subagentRows([denied({ toolStatus: 'in_progress' })], NOW)).toEqual([]);
    expect(subagentRows([denied({ toolStatus: 'pending' })], NOW)).toEqual([]);
    expect(subagentRows([denied({ toolStatus: 'completed' })], NOW)).toEqual([]);
  });

  it('never mistakes some OTHER tool failing for a sub-agent', () => {
    expect(subagentRows([denied({ toolName: 'bash' })], NOW)).toEqual([]);
    expect(subagentRows([denied({ toolName: undefined })], NOW)).toEqual([]);
  });

  it('needs a tool call id to key on, and invents nothing without one', () => {
    expect(subagentRows([denied({ toolCallId: undefined })], NOW)).toEqual([]);
    expect(subagentRows([denied({ toolCallId: '' })], NOW)).toEqual([]);
  });

  it('leaves a child that DID start on its own lifecycle', () => {
    // Not a failed spawn: the agent ran and then failed, so it settles as
    // `error` and keeps the drawer's dismiss control OFF — only a refused ask
    // carries that, and only a refused ask is auto-dismissed at the next turn.
    expect(subagentRows([denied({ taskSessionId: 'child-1' })], NOW)[0].state).toBe('error');
    // A background one is still out until the engine's marker, whatever its
    // own launcher card says.
    expect(subagentRows([denied({ taskSessionId: 'child-1', taskBackground: true })], NOW)[0].state)
      .toBe('running');
  });
});

// The drawer's own retirement, layered on TOP of subagentEntry.ts's
// permanent-failed rule (see subagentRows.ts's comment on the param): a key
// once dismissed must never resurface, regardless of state.
describe('subagentRows — dismissed keys never render, however they got there', () => {
  const denied = (over: Partial<SubagentMessage> = {}): SubagentMessage => ({
    label: 'task: audit the bundle',
    toolName: 'task',
    toolCallId: 'tc-1',
    toolStatus: 'failed',
    timestamp: NOW - 5_000,
    ...over,
  });

  it('a dismissed failed row is excluded', () => {
    expect(subagentRows([denied()], NOW, new Set(['tc-1']))).toEqual([]);
  });

  it('dismissing one key leaves an UNRELATED failed row showing', () => {
    const rows = subagentRows([
      denied({ toolCallId: 'tc-1' }),
      denied({ toolCallId: 'tc-2' }),
    ], NOW, new Set(['tc-1']));
    expect(rows.map((r) => r.key)).toEqual(['tc-2']);
  });

  it('no dismissedKeys argument behaves exactly as before (default empty)', () => {
    expect(subagentRows([denied()], NOW)).toHaveLength(1);
  });

  it('a dismissed key that matches nothing on the roster is simply a no-op', () => {
    expect(subagentRows([card()], NOW, new Set(['some-other-key']))).toHaveLength(1);
  });
});

describe('subagentRows — what a row shows about the child', () => {
  it('carries the model the child was ROUTED to, not the chat model', () => {
    expect(subagentRows([card({ taskModel: 'openrouter/qwen3-coder' })], NOW)[0].model)
      .toBe('openrouter/qwen3-coder');
  });

  it('has no model rather than an empty one when the card carried none', () => {
    expect(subagentRows([card({ taskModel: '  ' })], NOW)[0].model).toBeUndefined();
  });

  it('shows the TAIL of the live stream, so the row tracks what it is doing now', () => {
    const row = subagentRows([card({ taskStream: '> read: a.ts\n> bash: npm test\n> edit: b.ts\n' })], NOW)[0];
    expect(row.activity).toBe('> read: a.ts\n> bash: npm test\n> edit: b.ts');

    const long = subagentRows([card({ taskStream: '1\n2\n3\n4\n5\n' })], NOW)[0];
    expect(long.activity).toBe('3\n4\n5');
  });

  it('a silent child shows no activity block at all', () => {
    expect(subagentRows([card()], NOW)[0].activity).toBe('');
  });

  it('the forwarded stream now feeds the GLANCE only — nothing carries it whole', () => {
    // The full untailed buffer used to ride the row for the "open in tab"
    // full-stream document. That tab is retired: the buffer is transient and
    // never logged, so in a reopened chat it was empty and the tab printed
    // "(no output yet)" for the whole run. The child's own stored transcript
    // answers that now (SubagentDock.svelte), and this keeps the drawer's own
    // three-line tail as the only thing the chunk wire is used for.
    const row = subagentRows([card({ taskStream: '1\n2\n3\n4\n5\n' })], NOW)[0];
    expect(row.activity).toBe('3\n4\n5');
    expect('stream' in row).toBe(false);
  });
});
