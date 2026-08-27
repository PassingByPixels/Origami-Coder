// collabBoardData — the six flock M4 host leaves (lead, objective, the two
// task mutations, the ledger, stop). Same two things collabData.test.ts
// asserts: the exact wire method + params each one sends (the engine lane
// builds to the same contract), and that no path ever rejects — a dead engine
// or a missing collab degrades to an honest empty payload plus an `error`
// FIELD, never a thrown promise.

import { describe, it, expect } from 'vitest';
import {
  collabSetLead,
  collabSetObjective,
  collabStop,
  collabTaskAdd,
  collabTaskUpdate,
  collabLedger,
  collabUnarchive,
} from '../../../src/dashboard/collabBoardData';
import type { CollabSource } from '../../../src/dashboard/collabData';

/** A fake client that records every call and answers with a canned reply. */
function fake(reply: Record<string, unknown> | ((m: string) => Record<string, unknown>)) {
  const calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
  const client: CollabSource = {
    extMethod: async (method, params) => {
      calls.push({ method, params });
      return typeof reply === 'function' ? reply(method) : reply;
    },
  };
  return { client, calls };
}

const thrower = (msg: string): CollabSource => ({
  extMethod: async () => { throw new Error(msg); },
});

const task = (over: Record<string, unknown> = {}) => ({
  id: 't1',
  title: 'Wire the picker',
  owner: null,
  state: 'open',
  createdBy: 'user',
  result: null,
  note: null,
  originSeq: null,
  createdAt: '2026-08-05T00:00:00.000Z',
  updatedAt: '2026-08-05T00:00:00.000Z',
  ...over,
});

describe('collabBoardData — the wire', () => {
  it('collab_set_lead sends the collab id and the slug, null included', async () => {
    const { client, calls } = fake({ ok: true });
    await collabSetLead(client, 'c1', 'collab-crane', 'C:/repo');
    expect(calls[0]).toEqual({ method: 'collab_set_lead', params: { collabId: 'c1', agentSlug: 'collab-crane', cwd: 'C:/repo' } });

    const cleared = fake({ ok: true });
    await collabSetLead(cleared.client, 'c1', null);
    expect(cleared.calls[0].params).toEqual({ collabId: 'c1', agentSlug: null });
  });

  it('collab_set_objective sends the collab id and the text', async () => {
    const { client, calls } = fake({ ok: true });
    await collabSetObjective(client, 'c1', 'Ship the picker', 'C:/repo');
    expect(calls[0]).toEqual({ method: 'collab_set_objective', params: { collabId: 'c1', objective: 'Ship the picker', cwd: 'C:/repo' } });
  });

  it('collab_stop sends only the collab id', async () => {
    const { client, calls } = fake({ ok: true });
    await collabStop(client, 'c1');
    expect(calls[0]).toEqual({ method: 'collab_stop', params: { collabId: 'c1' } });
  });

  // collab-resume: the inverse of collabData's collabArchive.
  it('collab_unarchive sends only the collab id', async () => {
    const { client, calls } = fake({ ok: true });
    await collabUnarchive(client, 'c1');
    expect(calls[0]).toEqual({ method: 'collab_unarchive', params: { collabId: 'c1' } });
  });

  it('collab_task_add sends the collab id and the title', async () => {
    const { client, calls } = fake({ task: task() });
    await collabTaskAdd(client, 'c1', 'Wire the picker', 'C:/repo');
    expect(calls[0]).toEqual({ method: 'collab_task_add', params: { collabId: 'c1', title: 'Wire the picker', cwd: 'C:/repo' } });
  });

  it('collab_task_update sends the action plus only the extras the caller supplied', async () => {
    const { client, calls } = fake({ task: task({ state: 'claimed', owner: 'collab-crane' }) });
    await collabTaskUpdate(client, 'c1', 't1', 'claim', { owner: 'collab-crane' });
    expect(calls[0]).toEqual({
      method: 'collab_task_update',
      params: { collabId: 'c1', taskId: 't1', action: 'claim', owner: 'collab-crane' },
    });

    const bare = fake({ task: task({ state: 'accepted' }) });
    await collabTaskUpdate(bare.client, 'c1', 't1', 'accept');
    expect(bare.calls[0].params).toEqual({ collabId: 'c1', taskId: 't1', action: 'accept' });
  });

  it('collab_ledger sends limit only when it is a positive number', async () => {
    const first = fake({ entries: [], totals: [] });
    await collabLedger(first.client, 'c1');
    expect(first.calls[0].params).toEqual({ collabId: 'c1' });

    const limited = fake({ entries: [], totals: [] });
    await collabLedger(limited.client, 'c1', 20);
    expect(limited.calls[0].params).toEqual({ collabId: 'c1', limit: 20 });

    const zero = fake({ entries: [], totals: [] });
    await collabLedger(zero.client, 'c1', 0);
    expect(zero.calls[0].params).toEqual({ collabId: 'c1' });
  });
});

describe('collabBoardData — payload shape', () => {
  it('every payload self-carries collabId — a fanned-out reply must name what it is about', async () => {
    const { client } = fake({ ok: true });
    expect((await collabSetLead(client, 'c1', null)).collabId).toBe('c1');
    expect((await collabTaskAdd(client, 'c1', 't')).collabId).toBe('c1');
    expect((await collabLedger(client, 'c1')).collabId).toBe('c1');
  });

  it('a task reply with no usable task is an ERROR, never a half-real row', async () => {
    for (const reply of [{}, { task: null }, { task: { title: 'no id' } }, { task: { id: '' } }]) {
      const { client } = fake(reply as Record<string, unknown>);
      const out = await collabTaskAdd(client, 'c1', 't');
      expect(out.task).toBeNull();
      expect(out.error).toBe('The engine did not return a task.');
    }
  });

  it('a malformed ledger reply degrades to empty arrays instead of throwing', async () => {
    const { client } = fake({ entries: 'nope', totals: null });
    const out = await collabLedger(client, 'c1');
    expect([out.entries, out.totals]).toEqual([[], []]);
  });

  it('a ledger reply passes entries and totals through verbatim', async () => {
    const entries = [{ id: 'l1', agentSlug: 'collab-crane', model: 'lmstudio/qwen', tokensInput: 10, tokensOutput: 5, cost: 0.01, askedBy: null, createdAt: 'x' }];
    const totals = [{ agentSlug: 'collab-crane', cost: 0.01, tokensInput: 10, tokensOutput: 5 }];
    const { client } = fake({ entries, totals });
    expect(await collabLedger(client, 'c1')).toEqual({ collabId: 'c1', entries, totals });
  });
});

describe('collabBoardData — no engine, no crash', () => {
  it('every leaf answers with the no-session message rather than rejecting', async () => {
    expect((await collabSetLead(null, 'c1', null)).error).toContain('Open a chat first');
    expect((await collabSetObjective(undefined, 'c1', 'x')).error).toContain('Open a chat first');
    expect((await collabStop(null, 'c1')).error).toContain('Open a chat first');
    expect((await collabUnarchive(null, 'c1')).error).toContain('Open a chat first');
    expect((await collabTaskAdd(null, 'c1', 't')).error).toContain('Open a chat first');
    expect((await collabTaskUpdate(null, 'c1', 't1', 'accept')).error).toContain('Open a chat first');
    expect((await collabLedger(undefined, 'c1')).error).toContain('Open a chat first');
  });

  it('an empty collab id is refused BEFORE the engine is called', async () => {
    const { client, calls } = fake({});
    expect((await collabSetLead(client, '', null)).error).toBe('No collab was selected.');
    expect((await collabTaskAdd(client, '', 't')).error).toBe('No collab was selected.');
    expect((await collabLedger(client, '')).error).toBe('No collab was selected.');
    expect(calls).toEqual([]);
  });

  it('a task update with no task id is refused BEFORE the engine is called, even with a real collab id', async () => {
    const { client, calls } = fake({});
    expect((await collabTaskUpdate(client, 'c1', '', 'accept')).error).toBe('No task was selected.');
    expect(calls).toEqual([]);
  });

  it('a throwing engine becomes an `error` field on an otherwise honest empty payload', async () => {
    const client = thrower('engine offline');
    expect(await collabSetLead(client, 'c1', null)).toEqual({ collabId: 'c1', ok: false, error: 'engine offline' });
    expect(await collabStop(client, 'c1')).toEqual({ collabId: 'c1', ok: false, error: 'engine offline' });
    expect(await collabTaskAdd(client, 'c1', 't')).toEqual({ collabId: 'c1', task: null, error: 'engine offline' });
    expect(await collabLedger(client, 'c1')).toEqual({ collabId: 'c1', entries: [], totals: [], error: 'engine offline' });
  });

  // OWNER RULING (W6-L3): every collab refusal (an archived room, a blank
  // title…) rides the SDK's generic "Internal error: <reason>" wrapper the
  // same way the concurrency gate does — this leaf shares collabData.ts's
  // `message` rather than its own copy, so it must honour the same rule.
  it('a refusal wrapped in the wire\'s generic label reads as the refusal, not as "Internal error"', async () => {
    const client: CollabSource = {
      extMethod: async () => { throw Object.assign(new Error('Internal error: collab title must not be empty: c1'), { data: {} }); },
    };
    expect((await collabTaskAdd(client, 'c1', 't')).error).toBe('collab title must not be empty: c1');
  });
});
