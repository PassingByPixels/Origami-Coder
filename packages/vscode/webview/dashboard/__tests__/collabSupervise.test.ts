// collabSupervise — the host half of wave 1's four per-member collab methods
// (`collab_stop_agent`, `collab_redirect`, `collab_review`, `collab_preview`).
//
// Its own module, and its own dispatcher, because collabManager.ts sits at
// 292/300: the ratchet's remedy is a new module, never a raised cap. The four
// leaves follow collabData.ts's shape exactly — a no-engine guard, a throw
// turned into an `error` FIELD rather than a rejected promise, and a defensive
// read of a reply that crossed a JSON-RPC wire.
//
// WHAT IS ASSERTED HERE, and why each one is a real defect if it drifts:
//
//   1. A STOP NAMES ONE AGENT. `collab_stop_agent` is the narrow interrupt;
//      `collab_stop` takes the whole room and spends its budget. A wiring
//      mistake between the two is invisible in a screenshot and catastrophic
//      in a room.
//   2. THE STOP OUTCOME IS CARRIED, NOT COALESCED. The engine answers
//      `{interrupted, dequeued}` and never a bare ok, so a leaf that returned
//      `ok: true` would throw away the only thing the reply says.
//   3. THE PREVIEW COSTS NOTHING AND CANNOT REFUSE A SEND. It answers with an
//      empty wake set on any failure, so a dead engine leaves the composer
//      quiet rather than painting an error under a draft.

import { describe, it, expect } from 'vitest';
import {
  SUPERVISE_MESSAGE_TYPES,
  collabPreview,
  collabRedirect,
  collabReview,
  collabStopAgent,
  handleSuperviseMessage,
  type SuperviseHost,
} from '../../../src/dashboard/collabSupervise';
import type { CollabSource } from '../../../src/dashboard/collabData';

function fakeClient(
  reply: Record<string, unknown> | ((method: string, params?: Record<string, unknown>) => Record<string, unknown>),
) {
  const calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
  const client: CollabSource = {
    extMethod: async (method, params) => {
      calls.push({ method, params });
      return typeof reply === 'function' ? reply(method, params) : reply;
    },
  };
  return { client, calls };
}

const thrower = (message: string): CollabSource => ({
  extMethod: async () => {
    throw new Error(message);
  },
});

function fakeHost(client: CollabSource | undefined) {
  const posts: Array<Record<string, unknown>> = [];
  const host: SuperviseHost = {
    post: (msg) => posts.push(msg),
    cwd: () => 'C:/repo',
    collabClient: () => client,
  };
  return { host, posts };
}

describe('collabStopAgent', () => {
  it('names ONE agent on the narrow method, never the room-wide one', async () => {
    const { client, calls } = fakeClient({ interrupted: true, dequeued: false });
    await collabStopAgent(client, 'c1', 'collab-crane', 'C:/repo');
    expect(calls).toEqual([
      { method: 'collab_stop_agent', params: { collabId: 'c1', agentSlug: 'collab-crane', cwd: 'C:/repo' } },
    ]);
  });

  it('carries both halves of the outcome through', async () => {
    const { client } = fakeClient({ interrupted: false, dequeued: true });
    expect(await collabStopAgent(client, 'c1', 'collab-crane')).toEqual({
      collabId: 'c1',
      agentSlug: 'collab-crane',
      interrupted: false,
      dequeued: true,
    });
  });

  // A reply that crossed a JSON-RPC wire is read defensively: a missing flag
  // reads as "that did not happen", which is what the surface then reports.
  it('reads a malformed reply as neither, never as a stop that worked', async () => {
    const { client } = fakeClient({ interrupted: 'yes' });
    expect(await collabStopAgent(client, 'c1', 'collab-crane')).toMatchObject({
      interrupted: false,
      dequeued: false,
    });
  });

  it('answers with an error FIELD when the engine refuses, not a rejection', async () => {
    const res = await collabStopAgent(thrower('collab clb_x not found'), 'c1', 'collab-crane');
    expect(res.error).toContain('clb_x');
    expect(res.interrupted).toBe(false);
  });

  // OWNER RULING (W6-L3): this module shares collabData.ts's `message` rather
  // than its own copy, so a refusal wrapped in the wire's generic label reads
  // as the refusal here too, not as "Internal error: <reason>".
  it('a refusal wrapped in the wire\'s generic label reads as the refusal, not as "Internal error"', async () => {
    const client: CollabSource = {
      extMethod: async () => { throw Object.assign(new Error('Internal error: not in this collab: collab-crane'), { data: {} }); },
    };
    const res = await collabStopAgent(client, 'c1', 'collab-crane');
    expect(res.error).toBe('not in this collab: collab-crane');
  });

  it('refuses with no engine rather than calling', async () => {
    expect((await collabStopAgent(undefined, 'c1', 'collab-crane')).error).toMatch(/Open a chat first/);
  });
});

describe('collabRedirect', () => {
  it('sends the correction to one agent and answers with the seq it landed at', async () => {
    const { client, calls } = fakeClient({ seq: 12 });
    expect(await collabRedirect(client, 'c1', 'collab-crane', 'stop editing the schema', 'C:/repo')).toEqual({
      collabId: 'c1',
      agentSlug: 'collab-crane',
      seq: 12,
    });
    expect(calls[0]).toEqual({
      method: 'collab_redirect',
      params: { collabId: 'c1', agentSlug: 'collab-crane', text: 'stop editing the schema', cwd: 'C:/repo' },
    });
  });

  it('answers seq null with an error when the engine refuses', async () => {
    const res = await collabRedirect(thrower('empty text'), 'c1', 'collab-crane', '  ');
    expect(res).toMatchObject({ seq: null });
    expect(res.error).toContain('empty text');
  });
});

describe('collabReview', () => {
  const task = { id: 'clbt_1', title: 'write the migration', owner: 'bob', state: 'accepted' };

  it('sends the verdict and answers with the task exactly as it now stands', async () => {
    const { client, calls } = fakeClient({ task });
    expect(await collabReview(client, 'c1', 'clbt_1', 'approve', undefined, 'C:/repo')).toEqual({
      collabId: 'c1',
      task,
    });
    expect(calls[0]?.params).toEqual({ collabId: 'c1', taskId: 'clbt_1', verdict: 'approve', cwd: 'C:/repo' });
  });

  // The engine REFUSES a reject with no reason, and the row the owner is woken
  // by has to carry it. An empty note is omitted rather than sent blank, so the
  // engine's own refusal is what the user sees.
  it('carries a reject note, and omits the field when there is none', async () => {
    const { client, calls } = fakeClient({ task });
    await collabReview(client, 'c1', 'clbt_1', 'reject', 'the index is missing');
    await collabReview(client, 'c1', 'clbt_1', 'approve', '');
    expect(calls[0]?.params).toMatchObject({ verdict: 'reject', note: 'the index is missing' });
    expect(calls[1]?.params).not.toHaveProperty('note');
  });

  it('answers task null with the engine reason when the verdict is refused', async () => {
    const res = await collabReview(thrower('task clbt_1 is open, not done'), 'c1', 'clbt_1', 'approve');
    expect(res).toMatchObject({ task: null });
    expect(res.error).toContain('not done');
  });
});

describe('collabPreview', () => {
  it('asks with the address list and answers with the wake set', async () => {
    const { client, calls } = fakeClient({ wake: ['collab-crane'] });
    expect(await collabPreview(client, 'c1', ['collab-crane'], 'C:/repo')).toEqual({
      collabId: 'c1',
      wake: ['collab-crane'],
    });
    expect(calls[0]).toEqual({
      method: 'collab_preview',
      params: { collabId: 'c1', mentions: ['collab-crane'], cwd: 'C:/repo' },
    });
  });

  // An unaddressed draft is a real question — "who takes a message that names
  // nobody" — so the field is OMITTED rather than sent empty, exactly as
  // collab_post does it.
  it('omits mentions entirely for an unaddressed draft', async () => {
    const { client, calls } = fakeClient({ wake: ['collab-crane'] });
    await collabPreview(client, 'c1', []);
    expect(calls[0]?.params).not.toHaveProperty('mentions');
  });

  it('carries the no-lead notice and the unknown addresses', async () => {
    const { client } = fakeClient({ wake: [], notice: 'no-lead', unknown: ['fox'] });
    expect(await collabPreview(client, 'c1', [])).toEqual({
      collabId: 'c1',
      wake: [],
      notice: 'no-lead',
      unknown: ['fox'],
    });
  });

  // The composer must not paint an error line under a draft because the engine
  // blinked. A preview that cannot be answered is silence.
  it('is SILENT on failure — an empty wake set and no error field', async () => {
    expect(await collabPreview(thrower('engine died'), 'c1', [])).toEqual({ collabId: 'c1', wake: [] });
    expect(await collabPreview(undefined, 'c1', [])).toEqual({ collabId: 'c1', wake: [] });
  });

  it('drops a notice the contract does not name rather than forwarding it', async () => {
    const { client } = fakeClient({ wake: [], notice: 'something-new' });
    expect(await collabPreview(client, 'c1', [])).toEqual({ collabId: 'c1', wake: [] });
  });
});

describe('handleSuperviseMessage — the dispatcher', () => {
  it('names exactly the four wire types it owns', () => {
    expect([...SUPERVISE_MESSAGE_TYPES].sort()).toEqual([
      'collabPreview', 'collabRedirect', 'collabReview', 'collabStopAgent',
    ]);
  });

  it('routes a stop to the narrow method and replies with the outcome', async () => {
    const { client, calls } = fakeClient({ interrupted: true, dequeued: true });
    const { host, posts } = fakeHost(client);
    await handleSuperviseMessage(host, { type: 'collabStopAgent', collabId: 'c1', agentSlug: 'collab-crane' });
    expect(calls[0]?.method).toBe('collab_stop_agent');
    expect(posts).toEqual([
      { type: 'collabStopAgentResult', collabId: 'c1', agentSlug: 'collab-crane', interrupted: true, dequeued: true },
    ]);
  });

  it('routes a redirect and replies on its own type', async () => {
    const { client, calls } = fakeClient({ seq: 7 });
    const { host, posts } = fakeHost(client);
    await handleSuperviseMessage(host, {
      type: 'collabRedirect', collabId: 'c1', agentSlug: 'collab-crane', text: 'use the other table',
    });
    expect(calls[0]?.params).toMatchObject({ text: 'use the other table' });
    expect(posts[0]).toMatchObject({ type: 'collabRedirectResult', seq: 7 });
  });

  it('routes a verdict and replies with the task', async () => {
    const { client, calls } = fakeClient({ task: { id: 'clbt_1', state: 'claimed' } });
    const { host, posts } = fakeHost(client);
    await handleSuperviseMessage(host, {
      type: 'collabReview', collabId: 'c1', taskId: 'clbt_1', verdict: 'reject', note: 'missing index',
    });
    expect(calls[0]?.params).toMatchObject({ verdict: 'reject', note: 'missing index' });
    expect(posts[0]).toMatchObject({ type: 'collabReviewResult' });
  });

  // A verdict the contract does not name must never reach the engine as a
  // guess: `approve` and `reject` are the only two, and a stale shell sending a
  // third is refused here with a reason rather than coerced into one of them.
  it('refuses an unknown verdict without calling the engine', async () => {
    const { client, calls } = fakeClient({ task: {} });
    const { host, posts } = fakeHost(client);
    await handleSuperviseMessage(host, { type: 'collabReview', collabId: 'c1', taskId: 'clbt_1', verdict: 'accept' });
    expect(calls).toEqual([]);
    expect(posts[0]).toMatchObject({ type: 'collabReviewResult', task: null });
    expect(String(posts[0]?.error)).toMatch(/verdict/i);
  });

  it('routes a preview and replies on its own type', async () => {
    const { client, calls } = fakeClient({ wake: ['collab-crane'] });
    const { host, posts } = fakeHost(client);
    await handleSuperviseMessage(host, { type: 'collabPreview', collabId: 'c1', mentions: ['collab-crane'] });
    expect(calls[0]?.method).toBe('collab_preview');
    expect(posts[0]).toEqual({ type: 'collabPreviewData', collabId: 'c1', wake: ['collab-crane'] });
  });

  it('ignores a message it does not own', async () => {
    const { client, calls } = fakeClient({});
    const { host, posts } = fakeHost(client);
    await handleSuperviseMessage(host, { type: 'collabPoll', collabId: 'c1' });
    expect(calls).toEqual([]);
    expect(posts).toEqual([]);
  });
});
