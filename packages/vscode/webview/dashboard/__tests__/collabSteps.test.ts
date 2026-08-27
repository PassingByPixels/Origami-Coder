// collabSteps - the collab map's step source. A Collab owns no session, so
// this module MAKES a run out of N member sessions. What matters is that the
// made run never says more than the members did: the order is the members'
// own clocks, the lanes are the roster's own order, and a member that could
// not be read is named rather than quietly missing.

import { describe, it, expect, vi, afterEach } from 'vitest';
import type { RunStep } from '../../../src/acpExtTypes';
import { collabSessionMarks, collabStepsPayload } from '../../../src/dashboard/collabSteps';

type Part = { agentSlug: string; displayName?: string; model?: null; sessionId?: string };
/** A member's canned run: its steps, or a message the fetch throws with. */
type Run = RunStep[] | { throws: string } | { steps: RunStep[]; truncated: boolean; total: number };

const step = (ordinal: number, over: Partial<RunStep> = {}): RunStep =>
  ({ ordinal, kind: 'tool', title: `s${ordinal}`, ...over });

/** One fake standing in for AcpClient's two seams: `extMethod` (collab_list /
 *  collab_state) and the typed `getRunSteps`. */
function fake(
  participants: Part[],
  runs: Record<string, Run> = {},
  collabs: Array<{ id: string; title: string }> = [{ id: 'c1', title: 'Ship the thing' }],
  opts: { listThrows?: string; stateThrows?: Record<string, string> } = {},
) {
  return {
    extMethod: async (method: string, params: Record<string, unknown> = {}) => {
      if (method === 'collab_list') {
        if (opts.listThrows) throw new Error(opts.listThrows);
        return { collabs: collabs.map((c) => ({ ...c, createdAt: '', loopBreakerCap: null })) };
      }
      if (method === 'collab_state') {
        const id = String(params.collabId ?? '');
        if (opts.stateThrows?.[id]) throw new Error(opts.stateThrows[id]);
        const collab = collabs.find((c) => c.id === id) ?? null;
        return { collab, participants, messages: [], agents: [], suspended: false };
      }
      return {};
    },
    getRunSteps: async (sessionId: string) => {
      const run = runs[sessionId] ?? [];
      if (Array.isArray(run)) return { steps: run, truncated: false, total: run.length };
      if ('throws' in run) throw new Error(run.throws);
      return run;
    },
  };
}

const titles = (steps: RunStep[]) => steps.map((s) => s.title);
const lanes = (steps: RunStep[]) => steps.map((s) => s.parentOrdinal);

afterEach(() => vi.restoreAllMocks());

describe('collabStepsPayload - merge order', () => {
  it('orders the steps of every member by the clock the engine gave them, not by member', async () => {
    const client = fake(
      [{ agentSlug: 'crane', sessionId: 'ses_a' }, { agentSlug: 'heron', sessionId: 'ses_b' }],
      {
        ses_a: [step(0, { title: 'a-first', startedAt: 10 }), step(1, { title: 'a-last', startedAt: 30 })],
        ses_b: [step(0, { title: 'b-middle', startedAt: 20 })],
      },
    );
    const out = await collabStepsPayload(client, 'c1');
    expect(titles(out.steps)).toEqual(['a-first', 'b-middle', 'a-last']);
  });

  // Per-member ordinals repeat (every member's run starts at 0). A map that
  // kept them would show three "step 0"s and index the wrong step on a click.
  it('re-stamps ordinal over the MERGED list, so the incoming per-member numbering cannot repeat', async () => {
    const client = fake(
      [{ agentSlug: 'crane', sessionId: 'ses_a' }, { agentSlug: 'heron', sessionId: 'ses_b' }],
      {
        ses_a: [step(0, { startedAt: 10 }), step(1, { startedAt: 30 })],
        ses_b: [step(0, { startedAt: 20 })],
      },
    );
    const out = await collabStepsPayload(client, 'c1');
    expect(out.steps.map((s) => s.ordinal)).toEqual([0, 1, 2]);
  });

  // A missing clock is unknown, not zero. Sorting it as 0 would claim it ran
  // FIRST - a time the engine never reported.
  it('a step with no startedAt keeps its member-local order and lands after every timed step', async () => {
    const client = fake(
      [{ agentSlug: 'crane', sessionId: 'ses_a' }, { agentSlug: 'heron', sessionId: 'ses_b' }],
      {
        ses_a: [step(0, { title: 'a-untimed' }), step(1, { title: 'a-timed', startedAt: 100 })],
        ses_b: [step(0, { title: 'b-untimed' })],
      },
    );
    const out = await collabStepsPayload(client, 'c1');
    expect(titles(out.steps)).toEqual(['a-timed', 'a-untimed', 'b-untimed']);
  });

  it('two steps sharing one clock keep roster order rather than swapping between reads', async () => {
    const client = fake(
      [{ agentSlug: 'crane', sessionId: 'ses_a' }, { agentSlug: 'heron', sessionId: 'ses_b' }],
      { ses_a: [step(0, { title: 'crane-tie', startedAt: 5 })], ses_b: [step(0, { title: 'heron-tie', startedAt: 5 })] },
    );
    expect(titles((await collabStepsPayload(client, 'c1')).steps)).toEqual(['crane-tie', 'heron-tie']);
  });
});

describe('collabStepsPayload - per-member lanes', () => {
  it('every member gets depth 1 and its own negative parent key, in roster order', async () => {
    const client = fake(
      [
        { agentSlug: 'crane', sessionId: 'ses_a' },
        { agentSlug: 'heron', sessionId: 'ses_b' },
        { agentSlug: 'ibis', sessionId: 'ses_c' },
      ],
      {
        ses_a: [step(0, { startedAt: 1 })],
        ses_b: [step(0, { startedAt: 2 })],
        ses_c: [step(0, { startedAt: 3 })],
      },
    );
    const out = await collabStepsPayload(client, 'c1');
    expect(lanes(out.steps)).toEqual([-1, -2, -3]);
    expect(out.steps.every((s) => s.depth === 1)).toBe(true);
    expect(out.members).toEqual(['crane', 'heron', 'ibis']);
  });

  // Usage buckets partition by `agent`. A member step still carrying the
  // sub-agent name it ran under would bill its tokens to the wrong lane.
  it('bills every step to the member that ran it, overriding whatever agent the engine reported', async () => {
    const client = fake(
      [{ agentSlug: 'crane', sessionId: 'ses_a' }],
      { ses_a: [step(0, { agent: 'general-purpose' }), step(1, {})] },
    );
    const out = await collabStepsPayload(client, 'c1');
    expect(out.steps.map((s) => s.agent)).toEqual(['crane', 'crane']);
  });

  it('echoes the collab as the selection key and carries its title', async () => {
    const out = await collabStepsPayload(fake([{ agentSlug: 'crane', sessionId: 'ses_a' }]), 'c1');
    expect(out.sessionId).toBe('collab:c1');
    expect(out.collabTitle).toBe('Ship the thing');
  });
});

describe('collabStepsPayload - classification', () => {
  const FLOCK = ['ask', 'handoff', 'done', 'task_add', 'task_claim', 'task_done', 'task_accept', 'task_reopen'];

  it('flags every flock protocol tool and leaves ordinary work alone', async () => {
    const client = fake(
      [{ agentSlug: 'crane', sessionId: 'ses_a' }],
      { ses_a: [...FLOCK.map((tool, i) => step(i, { tool })), step(99, { tool: 'bash' })] },
    );
    const out = await collabStepsPayload(client, 'c1');
    expect(out.steps.map((s) => s.collabTool)).toEqual([...FLOCK.map(() => true), undefined]);
  });

  it('flags a runner envelope as a baton but never an ordinary human prompt', async () => {
    const client = fake([{ agentSlug: 'crane', sessionId: 'ses_a' }], {
      ses_a: [
        step(0, { kind: 'prompt', title: '[Collab: Ship the thing] crane, take task 2' }),
        step(1, { kind: 'prompt', title: 'summary', preview: '[Collab: Ship the thing] go' }),
        step(2, { kind: 'prompt', title: 'please fix the build' }),
      ],
    });
    const out = await collabStepsPayload(client, 'c1');
    expect(out.steps.map((s) => s.baton)).toEqual([true, true, undefined]);
  });

  // The honesty rule: classification never rewrites `kind`. A tool step whose
  // title happens to open with the envelope is a tool step.
  it('does not baton-flag a non-prompt step, and never changes the kind of a step', async () => {
    const client = fake([{ agentSlug: 'crane', sessionId: 'ses_a' }], {
      ses_a: [step(0, { kind: 'tool', tool: 'read', title: '[Collab: Ship the thing] read' })],
    });
    const out = await collabStepsPayload(client, 'c1');
    expect(out.steps[0]!.baton).toBeUndefined();
    expect(out.steps[0]!.kind).toBe('tool');
  });
});

describe('collabStepsPayload - honesty when a member is missing', () => {
  // A member with no sessionId has never taken a turn. Dropping it would slide
  // every later member up a lane and mislabel their steps.
  it('a member that never started contributes no steps but KEEPS its lane slot', async () => {
    const client = fake(
      [
        { agentSlug: 'crane', sessionId: 'ses_a' },
        { agentSlug: 'heron' },
        { agentSlug: 'ibis', sessionId: 'ses_c' },
      ],
      { ses_a: [step(0, { title: 'from-crane', startedAt: 1 })], ses_c: [step(0, { title: 'from-ibis', startedAt: 2 })] },
    );
    const out = await collabStepsPayload(client, 'c1');
    expect(out.members).toEqual(['crane', 'heron', 'ibis']);
    expect(titles(out.steps)).toEqual(['from-crane', 'from-ibis']);
    expect(lanes(out.steps)).toEqual([-1, -3]);
  });

  it('never asks the engine about a member that has no session', async () => {
    const asked: string[] = [];
    const client = fake([{ agentSlug: 'crane' }, { agentSlug: 'heron', sessionId: 'ses_b' }], { ses_b: [step(0)] });
    const spy = { ...client, getRunSteps: async (id: string) => (asked.push(id), client.getRunSteps(id)) };
    await collabStepsPayload(spy, 'c1');
    expect(asked).toEqual(['ses_b']);
  });

  it('names the member whose run cannot be read while the others still render', async () => {
    const client = fake(
      [{ agentSlug: 'crane', sessionId: 'ses_a' }, { agentSlug: 'heron', sessionId: 'ses_b' }],
      { ses_a: [step(0, { title: 'survives', startedAt: 1 })], ses_b: { throws: 'session not found' } },
    );
    const out = await collabStepsPayload(client, 'c1');
    expect(out.error).toBe('member heron unreadable: session not found');
    expect(titles(out.steps)).toEqual(['survives']);
    expect(out.members).toEqual(['crane', 'heron']);
  });

  it('reports EVERY unreadable member, not just the first', async () => {
    const client = fake(
      [{ agentSlug: 'crane', sessionId: 'ses_a' }, { agentSlug: 'heron', sessionId: 'ses_b' }],
      { ses_a: { throws: 'gone' }, ses_b: { throws: 'also gone' } },
    );
    const out = await collabStepsPayload(client, 'c1');
    expect(out.error).toBe('member crane unreadable: gone; member heron unreadable: also gone');
    expect(out.steps).toEqual([]);
  });

  it('a collab that cannot be read at all returns no steps and says why', async () => {
    const client = fake([], {}, [{ id: 'c1', title: 'Ship the thing' }], { stateThrows: { c1: 'collab store offline' } });
    const out = await collabStepsPayload(client, 'c1');
    expect(out.error).toBe('collab store offline');
    expect(out.steps).toEqual([]);
    expect(out.members).toEqual([]);
    expect(out.sessionId).toBe('collab:c1');
  });

  it('no client reports that a chat is needed instead of an empty collab', async () => {
    const out = await collabStepsPayload(null, 'c1');
    expect(out.error).toContain('Open a chat first');
    expect(out.steps).toEqual([]);
  });

  // The pane shows a truncation banner off `total` vs the steps it received.
  // Losing a member's truncation would present a partial run as the whole run.
  it('carries the truncation of a member and sums the real totals', async () => {
    const client = fake(
      [{ agentSlug: 'crane', sessionId: 'ses_a' }, { agentSlug: 'heron', sessionId: 'ses_b' }],
      { ses_a: { steps: [step(0)], truncated: true, total: 500 }, ses_b: [step(0)] },
    );
    const out = await collabStepsPayload(client, 'c1');
    expect(out.truncated).toBe(true);
    expect(out.total).toBe(501);
    expect(out.steps).toHaveLength(2);
  });
});

describe('collabStepsPayload - the eight-lane cap', () => {
  const roster = (n: number): Part[] =>
    Array.from({ length: n }, (_, i) => ({ agentSlug: `m${i}`, sessionId: `ses_${i}` }));
  const runs = (n: number): Record<string, Run> =>
    Object.fromEntries(roster(n).map((p, i) => [p.sessionId!, [step(0, { title: `t${i}`, startedAt: i })]]));

  it('eight members are eight lanes - nothing folds', async () => {
    const out = await collabStepsPayload(fake(roster(8), runs(8)), 'c1');
    expect(out.members).toEqual(['m0', 'm1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7']);
    expect(lanes(out.steps)).toEqual([-1, -2, -3, -4, -5, -6, -7, -8]);
  });

  it('a longer roster folds its tail into the LAST lane under a counted label', async () => {
    const out = await collabStepsPayload(fake(roster(10), runs(10)), 'c1');
    expect(out.members).toEqual(['m0', 'm1', 'm2', 'm3', 'm4', 'm5', 'm6', '+3 more']);
    // m7, m8 and m9 all share lane 8; nobody is dropped.
    expect(lanes(out.steps)).toEqual([-1, -2, -3, -4, -5, -6, -7, -8, -8, -8]);
    expect(out.steps).toHaveLength(10);
  });

  // The label stands for a COUNT of members; the steps keep their real author,
  // so per-agent usage inside the folded lane is still attributable.
  it('keeps a folded member billed to itself, not to the fold label', async () => {
    const out = await collabStepsPayload(fake(roster(10), runs(10)), 'c1');
    expect(out.steps.slice(7).map((s) => s.agent)).toEqual(['m7', 'm8', 'm9']);
  });
});

describe('collabSessionMarks - the history index decoration', () => {
  it('maps every member session to its collab', async () => {
    const client = fake([{ agentSlug: 'crane', sessionId: 'ses_a' }, { agentSlug: 'heron', sessionId: 'ses_b' }]);
    const marks = await collabSessionMarks(client);
    expect(marks.get('ses_a')).toEqual({ collabId: 'c1', collabTitle: 'Ship the thing', agentSlug: 'crane' });
    expect(marks.get('ses_b')!.agentSlug).toBe('heron');
  });

  it('a participant that never started leaves no mark - there is no run to decorate', async () => {
    const marks = await collabSessionMarks(fake([{ agentSlug: 'crane' }]));
    expect(marks.size).toBe(0);
  });

  // The index must list every run even when the collab store is unreachable.
  // An undecorated row lost a label; a throw here would lose the whole index.
  it('a failed collab read yields NO marks and exactly one warning, never a throw', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const marks = await collabSessionMarks(fake([], {}, [], { listThrows: 'engine offline' }));
    expect(marks.size).toBe(0);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain('engine offline');
  });

  it('one unreadable collab does not cost the other collabs their labels', async () => {
    const client = fake(
      [{ agentSlug: 'crane', sessionId: 'ses_a' }],
      {},
      [{ id: 'c1', title: 'Ship the thing' }, { id: 'c2', title: 'Broken' }],
      { stateThrows: { c2: 'row corrupt' } },
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const marks = await collabSessionMarks(client);
    expect(marks.get('ses_a')!.collabId).toBe('c1');
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('no client means no decoration and no warning - this is not an error state', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect((await collabSessionMarks(null)).size).toBe(0);
    expect(warn).not.toHaveBeenCalled();
  });
});
