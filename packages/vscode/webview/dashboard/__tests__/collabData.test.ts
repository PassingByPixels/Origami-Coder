// collabData — the six `collab_*` host leaves. What matters, and what is
// therefore asserted: the exact wire method + params each one sends (the
// engine lane builds to the same contract, so a renamed field here is a
// silent break there), and that no path ever rejects — a dead engine or a
// missing session degrades to an honest empty payload plus an `error` FIELD,
// the shape boardData.ts/promptCapture.ts already established.

import { describe, it, expect } from 'vitest';
import {
  collabAgents,
  collabList,
  collabCreate,
  collabPost,
  collabState,
  collabSetCap,
  collabSetConcurrency,
  message,
  type CollabSource,
} from '../../../src/dashboard/collabData';

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

/** A rejection shaped exactly like `@agentclientprotocol/sdk`'s `RequestError`
 *  — an `Error` whose `.message` carries the generic JSON-RPC label the SDK
 *  prepends to any thrown-not-typed exception, plus the optional `.data` a
 *  typed refusal MAY ride instead. This is what a real engine rejection
 *  crosses the wire as; a plain `thrower()` above is not representative of it. */
const rpcThrower = (msg: string, data?: unknown): CollabSource => ({
  extMethod: async () => { throw Object.assign(new Error(msg), { code: -32603, data }); },
});

describe('collabData — the wire', () => {
  it('collab_agents / collab_list carry the cwd and nothing else', async () => {
    const a = fake({ agents: [] });
    await collabAgents(a.client, 'C:/repo');
    expect(a.calls).toEqual([{ method: 'collab_agents', params: { cwd: 'C:/repo' } }]);

    const l = fake({ collabs: [] });
    await collabList(l.client, 'C:/repo');
    expect(l.calls).toEqual([{ method: 'collab_list', params: { cwd: 'C:/repo' } }]);
  });

  it('a blank cwd is OMITTED, not sent empty — an empty string is a path, not "you decide"', async () => {
    const { client, calls } = fake({ collabs: [] });
    await collabList(client, '');
    expect(calls[0].params).toEqual({});
  });

  it('collab_create sends the title and the roster verbatim', async () => {
    const { client, calls } = fake({ collab: { id: 'c1', title: 'Storm', createdAt: 'x', loopBreakerCap: null } });
    await collabCreate(client, 'Storm', ['collab-crane', 'collab-heron'], 'C:/repo');
    expect(calls[0]).toEqual({
      method: 'collab_create',
      params: { title: 'Storm', agentSlugs: ['collab-crane', 'collab-heron'], cwd: 'C:/repo' },
    });
  });

  it('collab_post sends the collab id and the text', async () => {
    const { client, calls } = fake({ seq: 7 });
    const out = await collabPost(client, 'c1', 'ship it');
    expect(calls[0]).toEqual({ method: 'collab_post', params: { collabId: 'c1', text: 'ship it' } });
    expect(out).toEqual({ collabId: 'c1', seq: 7 });
  });

  // The engine answers `collab_post` with `notice: 'no-lead'` when the message
  // reached NOBODY (no mentions, no lead). Dropping it at this boundary is what
  // made a first post into an empty room land in silence, so the field is
  // carried — and only when the engine actually stated it.
  it('collab_post carries the engine notice back — a post nobody received says so', async () => {
    const { client } = fake({ seq: 7, notice: 'no-lead' });
    expect(await collabPost(client, 'c1', 'anyone there?')).toEqual({ collabId: 'c1', seq: 7, notice: 'no-lead' });
  });

  it('collab_post drops a notice the contract does not name rather than forwarding it', async () => {
    const { client } = fake({ seq: 7, notice: 'something-else' });
    expect(await collabPost(client, 'c1', 'ship it')).toEqual({ collabId: 'c1', seq: 7 });
  });

  it('collab_state sends sinceSeq only when there IS one — a first read asks for everything', async () => {
    const first = fake({ collab: null, messages: [] });
    await collabState(first.client, 'c1');
    expect(first.calls[0].params).toEqual({ collabId: 'c1' });

    const next = fake({ collab: null, messages: [] });
    await collabState(next.client, 'c1', 12);
    expect(next.calls[0].params).toEqual({ collabId: 'c1', sinceSeq: 12 });
  });

  it('collab_set_cap sends null and 0 as themselves — the two are never folded together', async () => {
    const off = fake({ ok: true });
    await collabSetCap(off.client, 'c1', 0);
    expect(off.calls[0]).toEqual({ method: 'collab_set_cap', params: { collabId: 'c1', cap: 0 } });

    const dflt = fake({ ok: true });
    await collabSetCap(dflt.client, 'c1', null);
    expect(dflt.calls[0]).toEqual({ method: 'collab_set_cap', params: { collabId: 'c1', cap: null } });
  });
});

// Flock M4 wave X2 — three OPTIONAL additions to the same three methods. The
// rule they share, and the one worth a test each: an absent value must leave
// the wire shape EXACTLY as it is today, because the engine lane treats an
// empty string / empty array as a value the user chose.
describe('collabData — the flock M4 optional fields', () => {
  it('collab_post carries the parsed mentions when there are any', async () => {
    const { client, calls } = fake({ seq: 7 });
    await collabPost(client, 'c1', 'ping @collab-heron', undefined, ['collab-heron']);
    expect(calls[0]).toEqual({
      method: 'collab_post',
      params: { collabId: 'c1', text: 'ping @collab-heron', mentions: ['collab-heron'] },
    });
  });

  it('...and OMITS the field for an unaddressed post — never sends an empty array', async () => {
    for (const mentions of [undefined, [] as string[]]) {
      const { client, calls } = fake({ seq: 7 });
      await collabPost(client, 'c1', 'ship it', undefined, mentions);
      expect(calls[0].params, `mentions: ${JSON.stringify(mentions)}`).toEqual({ collabId: 'c1', text: 'ship it' });
    }
  });

  // M4.2 attachments ride the SAME method under the same omit-when-empty rule.
  // They go as BARE data URLs, not as {dataUrl, name} objects — the engine's
  // `collab_post` refuses anything that is not a non-empty string, so a wrapper
  // object here would be a post refused on shape rather than on content.
  it('collab_post carries the attachments as bare data URLs', async () => {
    const { client, calls } = fake({ seq: 7 });
    await collabPost(client, 'c1', 'look', undefined, undefined, ['data:image/png;base64,AA==']);
    expect(calls[0]).toEqual({
      method: 'collab_post',
      params: { collabId: 'c1', text: 'look', images: ['data:image/png;base64,AA=='] },
    });
  });

  it('...and OMITS them when there are none, leaving every ordinary post byte-identical', async () => {
    for (const images of [undefined, [] as string[]]) {
      const { client, calls } = fake({ seq: 7 });
      await collabPost(client, 'c1', 'ship it', undefined, undefined, images);
      expect(calls[0].params, `images: ${JSON.stringify(images)}`).toEqual({ collabId: 'c1', text: 'ship it' });
    }
  });

  it('mentions and images ride together without disturbing each other', async () => {
    const { client, calls } = fake({ seq: 7 });
    await collabPost(client, 'c1', 'ping @collab-heron', 'C:/repo', ['collab-heron'], ['data:image/png;base64,AA==']);
    expect(calls[0].params).toEqual({
      collabId: 'c1',
      text: 'ping @collab-heron',
      mentions: ['collab-heron'],
      images: ['data:image/png;base64,AA=='],
      cwd: 'C:/repo',
    });
  });

  it('collab_create carries the objective when one was typed, and omits a blank one', async () => {
    const reply = { collab: { id: 'c1', title: 'Storm', createdAt: 'x', loopBreakerCap: null } };
    const withObj = fake(reply);
    await collabCreate(withObj.client, 'Storm', [], undefined, 'Ship the wire');
    expect(withObj.calls[0].params).toEqual({ title: 'Storm', agentSlugs: [], objective: 'Ship the wire' });

    const blank = fake(reply);
    await collabCreate(blank.client, 'Storm', [], undefined, '');
    expect(blank.calls[0].params).toEqual({ title: 'Storm', agentSlugs: [] });
  });

  it('collab_state passes the board fields through as they arrive', async () => {
    const { client } = fake({
      collab: null, messages: [],
      lead: 'collab-crane', objective: 'Ship the wire',
      tasks: [{ id: 't1', title: 'Build it', owner: 'collab-heron', state: 'done', createdBy: 'collab-crane', result: 'done', note: null, originSeq: 4, createdAt: 'x', updatedAt: 'y' }],
      costTotals: [{ agentSlug: 'collab-crane', cost: 0.5, tokensInput: 10, tokensOutput: 20 }],
      hopState: { remaining: 0, cap: 6 },
    });
    const out = await collabState(client, 'c1');
    expect(out.lead).toBe('collab-crane');
    expect(out.objective).toBe('Ship the wire');
    expect(out.tasks?.map((t) => t.state)).toEqual(['done']);
    expect(out.costTotals?.[0].cost).toBe(0.5);
    expect(out.hopState).toEqual({ remaining: 0, cap: 6 });
  });

  it('an engine that sends NONE of them leaves every board field absent — never a fabricated null lead or an empty board', async () => {
    const { client } = fake({ collab: null, messages: [], suspended: false });
    const out = await collabState(client, 'c1');
    expect('lead' in out).toBe(false);
    expect('objective' in out).toBe(false);
    expect(out.tasks).toBeUndefined();
    expect(out.costTotals).toBeUndefined();
    expect(out.hopState).toBeUndefined();
  });

  it('a lead the engine explicitly CLEARED (null) is passed through as null, not dropped', async () => {
    const { client } = fake({ collab: null, messages: [], lead: null, objective: null });
    const out = await collabState(client, 'c1');
    expect(out.lead).toBeNull();
    expect(out.objective).toBeNull();
  });

  it('a malformed board (non-array tasks/costTotals) is DROPPED rather than rendered as empty', async () => {
    const { client } = fake({ collab: null, messages: [], tasks: 'nope', costTotals: 42, hopState: 'later' });
    const out = await collabState(client, 'c1');
    expect(out.tasks).toBeUndefined();
    expect(out.costTotals).toBeUndefined();
    expect(out.hopState).toBeUndefined();
  });
});

// W3-L1 (the Collabs overview pane). The pane is a WEBVIEW module and
// tsconfig.webview.json pins rootDir to `webview/`, so it cannot import
// src/dashboard/collabAttention.ts — and a second copy of that rule webview-side
// is exactly how two surfaces start disagreeing about whether a room is stuck.
// So the verdict is computed HERE, at the one place every `collabStateData`
// payload is built (the pane's own poll and collabWatch's background poll both
// come through this function), and rides the payload as one boolean.
describe('collabData — the needs-you verdict rides the state payload', () => {
  it('answers TRUE for a suspended room — the loop breaker waits on a human by construction', async () => {
    const { client } = fake({ collab: null, messages: [], agents: [], suspended: true });
    expect((await collabState(client, 'c1')).needsUser).toBe(true);
  });

  it('answers TRUE for a settled room with a finished task waiting to be accepted', async () => {
    const { client } = fake({
      collab: null, messages: [], suspended: false,
      agents: [{ slug: 'collab-crane', state: 'idle' }],
      tasks: [{ id: 't1', title: 'Build it', owner: 'collab-heron', state: 'done', createdBy: 'collab-crane', result: 'r', note: null, originSeq: 4, createdAt: 'x', updatedAt: 'y' }],
    });
    expect((await collabState(client, 'c1')).needsUser).toBe(true);
  });

  // The rule's own precedence, asserted through this seam so a future change to
  // collabAttention.ts cannot silently stop reaching the pane: work in flight
  // means the next move is the AGENT's, whatever is on the board.
  it('answers FALSE while an agent is still running, even with a done task on the board', async () => {
    const { client } = fake({
      collab: null, messages: [], suspended: false,
      agents: [{ slug: 'collab-crane', state: 'running' }],
      tasks: [{ id: 't1', title: 'Build it', owner: 'collab-heron', state: 'done', createdBy: 'collab-crane', result: 'r', note: null, originSeq: 4, createdAt: 'x', updatedAt: 'y' }],
    });
    expect((await collabState(client, 'c1')).needsUser).toBe(false);
  });

  it('answers FALSE — never undefined — on a refusal, so no surface reads a dead engine as a summons', async () => {
    expect((await collabState(null, 'c1')).needsUser).toBe(false);
    expect((await collabState(thrower('engine offline'), 'c1')).needsUser).toBe(false);
  });
});

describe('collabData — payload shape', () => {
  it('passes a state reply through, echoing sinceSeq so a consumer can tell full from incremental', async () => {
    const { client } = fake({
      collab: { id: 'c1', title: 'Storm', createdAt: 'x', loopBreakerCap: 0 },
      participants: [{ agentSlug: 'collab-crane', displayName: 'Crane', model: null }],
      messages: [{ seq: 4, authorId: 'user', authorKind: 'human', text: 'go', createdAt: 'x' }],
      agents: [{ slug: 'collab-crane', state: 'running', lastError: 'boom' }],
      suspended: true,
    });
    const out = await collabState(client, 'c1', 3);
    expect(out).toEqual({
      collabId: 'c1',
      sinceSeq: 3,
      collab: { id: 'c1', title: 'Storm', createdAt: 'x', loopBreakerCap: 0 },
      participants: [{ agentSlug: 'collab-crane', displayName: 'Crane', model: null }],
      messages: [{ seq: 4, authorId: 'user', authorKind: 'human', text: 'go', createdAt: 'x' }],
      agents: [{ slug: 'collab-crane', state: 'running', lastError: 'boom' }],
      suspended: true,
      // W3-L1: the ANSWER to collabAttention.ts's collabNeedsUser, computed once
      // here so every surface reads the same verdict. See its own block below.
      needsUser: true,
    });
  });

  it('`suspended` is read strictly — anything that is not literally true reads as RUNNING', async () => {
    for (const value of [undefined, 'true', 1, null]) {
      const { client } = fake({ collab: null, messages: [], suspended: value as never });
      expect((await collabState(client, 'c1')).suspended, `suspended: ${String(value)}`).toBe(false);
    }
  });

  it('a malformed reply (non-array lists) degrades to empty arrays instead of throwing', async () => {
    const { client } = fake({ agents: 'nope', collabs: 42, participants: null, messages: undefined });
    expect((await collabAgents(client)).agents).toEqual([]);
    expect((await collabList(client)).collabs).toEqual([]);
    const st = await collabState(client, 'c1');
    expect([st.participants, st.messages, st.agents]).toEqual([[], [], []]);
  });

  it('a create that returns no usable collab is an ERROR, never a half-real row', async () => {
    for (const reply of [{}, { collab: null }, { collab: { title: 'no id' } }, { collab: { id: '' } }]) {
      const { client } = fake(reply as Record<string, unknown>);
      const out = await collabCreate(client, 't', []);
      expect(out.collab).toBeNull();
      expect(out.error).toBe('The engine did not return a collab.');
    }
  });

  it('a post whose reply carries no seq reports null rather than inventing one', async () => {
    const { client } = fake({});
    expect(await collabPost(client, 'c1', 'x')).toEqual({ collabId: 'c1', seq: null });
  });
});

// OWNER RULING (W6-L3): "the collab refusal painted as 'Internal error:
// parallel turns need…' in the sidebar" — the SDK wraps every thrown-not-typed
// exception in a generic JSON-RPC label (`RequestError.internalError`), and
// EVERY collab refusal (a blank title, an archived room, the concurrency
// gate…) rides that same wrapper. A refusal must read as itself.
describe('collabData — a refusal reads as itself, not as a bug', () => {
  it('strips the wire label off the exact shape the concurrency gate sends today', async () => {
    // The literal text CollabParallel.concurrencyRefusal produces, wrapped the
    // way ACPError.toRequestError -> RequestError.internalError(data, safeMessage)
    // actually sends it: `.message` carries the label, `.data` carries only
    // `{service: 'collab'}` — no `.reason` field to fall back on.
    const refusal =
      'parallel turns need every member to be read-only for files, and these can still write: collab-crane (write). ' +
      'Give them `permissions: strict` in their definition, or leave this room at concurrency 1.';
    const client = rpcThrower(`Internal error: ${refusal}`, { service: 'collab' });
    const res = await collabSetConcurrency(client, 'c1', 3);
    expect(res).toEqual({ collabId: 'c1', ok: false, error: refusal });
    expect(res.error).not.toContain('Internal error');
  });

  it('prefers a typed `data.reason` over the label-stripped message, for a refusal sent that way instead', async () => {
    const client = rpcThrower('Internal error', { reason: 'that title is already taken' });
    expect(await collabAgents(client)).toEqual({ agents: [], error: 'that title is already taken' });
  });

  it('leaves a BARE label exactly as it is — a genuinely unexpected failure must keep saying so', async () => {
    const client = rpcThrower('Internal error');
    expect(await collabAgents(client)).toEqual({ agents: [], error: 'Internal error' });
  });

  it('strips every generic JSON-RPC label the SDK emits, not only "Internal error"', async () => {
    expect(message(Object.assign(new Error('Invalid params: bad shape'), {}))).toBe('bad shape');
    expect(message(Object.assign(new Error('Invalid request: missing id'), {}))).toBe('missing id');
  });

  it('a message that never carried the label passes through untouched', async () => {
    const client = thrower('collab is archived: c1');
    expect((await collabAgents(client)).error).toBe('collab is archived: c1');
  });
});

describe('collabData — no engine, no crash', () => {
  it('every leaf answers with the no-session message rather than rejecting', async () => {
    expect((await collabAgents(null)).error).toContain('Open a chat first');
    expect((await collabList(undefined)).error).toContain('Open a chat first');
    expect((await collabCreate(null, 't', [])).error).toContain('Open a chat first');
    expect((await collabPost(null, 'c1', 'x')).error).toContain('Open a chat first');
    expect((await collabState(null, 'c1')).error).toContain('Open a chat first');
    expect((await collabSetCap(null, 'c1', 3)).error).toContain('Open a chat first');
  });

  it('a throwing engine becomes an `error` field on an otherwise honest empty payload', async () => {
    const client = thrower('engine offline');
    expect(await collabAgents(client)).toEqual({ agents: [], error: 'engine offline' });
    expect(await collabList(client)).toEqual({ collabs: [], error: 'engine offline' });
    expect(await collabCreate(client, 't', [])).toEqual({ collab: null, error: 'engine offline' });
    expect(await collabPost(client, 'c1', 'x')).toEqual({ collabId: 'c1', seq: null, error: 'engine offline' });
    expect(await collabSetCap(client, 'c1', null)).toEqual({ collabId: 'c1', ok: false, error: 'engine offline' });

    const st = await collabState(client, 'c1', 5);
    expect(st).toMatchObject({ collabId: 'c1', sinceSeq: 5, collab: null, messages: [], suspended: false, error: 'engine offline' });
  });

  it('an empty collab id is refused BEFORE the engine is called — it would be a meaningless query', async () => {
    const { client, calls } = fake({});
    expect((await collabState(client, '')).error).toBe('No collab was selected.');
    expect((await collabSetCap(client, '', 0)).error).toBe('No collab was selected.');
    expect(calls).toEqual([]);
  });

  it('a set-cap that reached the engine reports ok — the wire, not a guess', async () => {
    const { client } = fake({ ok: true });
    expect(await collabSetCap(client, 'c1', 4)).toEqual({ collabId: 'c1', ok: true });
  });
});
