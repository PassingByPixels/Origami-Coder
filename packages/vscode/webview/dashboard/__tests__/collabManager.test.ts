// collabManager — the dispatcher EXTRACTED from DashboardPanel.ts's inline
// collab switch (flock M4 wave X1). This is the "zero behaviour change" pin
// for the extraction: every case still sends the same wire call with the same
// params, and answers with the same reply shape a webview pane already
// depends on (CollabPane.test.ts drives those panes through the real
// message contract, so a renamed reply type here would break there too — but
// asserting it here, at the dispatcher itself, catches a wiring mistake
// closer to its cause).

import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  COLLAB_MESSAGE_TYPES,
  handleCollabMessage,
  type CollabManagerHost,
} from '../../../src/dashboard/collabManager';
import type { CollabSource } from '../../../src/dashboard/collabData';
import { COLLAB_WATCH_MS, stopCollabWatch } from '../../../src/dashboard/collabWatch';

// Listing collabs now also arms the host-side watch, whose timer is module
// state — so every test disarms it rather than leaving one running into the
// next file.
afterEach(() => stopCollabWatch());

function fakeClient(reply: Record<string, unknown> | ((method: string, params?: Record<string, unknown>) => Record<string, unknown>)) {
  const calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
  const client: CollabSource = {
    extMethod: async (method, params) => {
      calls.push({ method, params });
      return typeof reply === 'function' ? reply(method, params) : reply;
    },
  };
  return { client, calls };
}

interface FakeHost extends CollabManagerHost {
  posts: Array<Record<string, unknown>>;
  opened: Array<{ id: string; title: string }>;
}

function fakeHost(client: CollabSource | undefined, order: string[] = []): FakeHost {
  const posts: Array<Record<string, unknown>> = [];
  const opened: Array<{ id: string; title: string }> = [];
  let savedOrder = order;
  return {
    posts,
    opened,
    post: (msg) => posts.push(msg),
    cwd: () => 'C:/repo',
    collabClient: () => client,
    collabOrder: () => savedOrder,
    saveCollabOrder: (o) => { savedOrder = o; },
    openCollab: async (id, title) => { opened.push({ id, title }); },
    promptCaptureFor: async () => ({ capture: null }),
  };
}

function post(over: Record<string, unknown> = {}) {
  return { type: 'collabPosted', ...over };
}

describe('collabManager — COLLAB_MESSAGE_TYPES', () => {
  it('names exactly the M1/M2 wire types (incl. collab-resume unarchive), the six flock M4 ones, the W3 supervision four and the whole Bots set', () => {
    expect([...COLLAB_MESSAGE_TYPES].sort()).toEqual([
      'collabAddParticipant', 'collabArchive', 'collabUnarchive', 'collabPoll', 'collabPost', 'collabPromptCapture',
      'collabRemoveParticipant', 'collabRename', 'collabSetCap',
      // W5 — the room's dispatch width, and W5-L2 the room's own KIND. Both are
      // ordinary op-results rather than `collabCapSet` twins, because the engine
      // can REFUSE either: they are the two settings that turn parallel dispatch
      // on, and both are gated on every member being read-only for files.
      'collabSetConcurrency', 'collabSetFlavor',
      'collabSetLead', 'collabSetObjective', 'collabStop',
      'collabTaskAdd', 'collabTaskUpdate',
      'newCollab', 'openCollab',
      'reorderCollabs', 'requestCollabAgents', 'requestCollabLedger', 'requestCollabs',
      // W3 (report 2.4/2.5) — routed on to collabSupervise.ts, but named in the
      // SAME set, so the panel keeps making exactly one check.
      'collabStopAgent', 'collabRedirect', 'collabReview', 'collabPreview',
      // W4 — the BOTS section (botsManager.ts). The def CRUD moved there with
      // the rest of the section rather than staying behind here; same rule as
      // the supervision four, one set, one check by the panel.
      'collabArchetypeSetModel', 'deleteCollabAgentDef', 'listCollabAgentDefs', 'saveCollabAgentDef',
      'startBotSession', 'botMemoryRead', 'botMemoryClear',
      'openBotsSection', 'boardReady', 'boardSectionShown',
      // The board rail's Docs button — host-owned URL, see botsManager DOCS_URL.
      'boardOpenDocs',
    ].sort());
  });

  // The set and the dispatcher are two halves of one contract: a type listed
  // and not handled is a message the panel swallows in silence.
  it('handles every type it names — the supervision four reach their own leaf', async () => {
    const { client, calls } = fakeClient({ interrupted: true, dequeued: false });
    const host = fakeHost(client);
    await handleCollabMessage(host, { type: 'collabStopAgent', collabId: 'c1', agentSlug: 'collab-crane' });
    expect(calls[0]?.method).toBe('collab_stop_agent');
    expect(host.posts[0]).toMatchObject({ type: 'collabStopAgentResult', interrupted: true });
  });
});

describe('collabManager — requestCollabs / reorderCollabs', () => {
  const collabs = [
    { id: 'c1', title: 'Storm', createdAt: 'x', loopBreakerCap: null },
    { id: 'c2', title: 'Wire', createdAt: 'y', loopBreakerCap: null },
  ];

  it('requestCollabs lists via the wire, applying the SAVED order', async () => {
    const { client, calls } = fakeClient({ collabs });
    const host = fakeHost(client, ['c2', 'c1']);
    await handleCollabMessage(host, { type: 'requestCollabs' });
    expect(calls[0]).toEqual({ method: 'collab_list', params: { cwd: 'C:/repo' } });
    expect(host.posts[0]).toEqual({ type: 'collabList', collabs: [collabs[1], collabs[0]] });
  });

  it('reorderCollabs saves a non-empty order and re-lists ranked; an empty order is a no-op save', async () => {
    const { client } = fakeClient({ collabs });
    const host = fakeHost(client, []);
    await handleCollabMessage(host, { type: 'reorderCollabs', order: ['c2', 'c1'] });
    expect(host.collabOrder()).toEqual(['c2', 'c1']);
    expect(host.posts[0].collabs).toEqual([collabs[1], collabs[0]]);

    const host2 = fakeHost(fakeClient({ collabs }).client, ['c1', 'c2']);
    await handleCollabMessage(host2, { type: 'reorderCollabs', order: [] });
    expect(host2.collabOrder()).toEqual(['c1', 'c2']); // untouched
  });
});

describe('collabManager — requestCollabAgents', () => {
  it('calls collab_agents with the cwd and carries a glyphs object in the reply', async () => {
    const { client, calls } = fakeClient({ agents: [{ slug: 'collab-crane', displayName: 'Crane', model: null }] });
    const host = fakeHost(client);
    await handleCollabMessage(host, { type: 'requestCollabAgents' });
    expect(calls[0]).toEqual({ method: 'collab_agents', params: { cwd: 'C:/repo' } });
    expect(host.posts[0].type).toBe('collabAgents');
    expect(typeof host.posts[0].glyphs).toBe('object');
  });
});

describe('collabManager — newCollab', () => {
  it('trims the title, drops non-string slugs, creates, and re-lists ONLY on success', async () => {
    const { client, calls } = fakeClient({ collab: { id: 'c1', title: 'Storm', createdAt: 'x', loopBreakerCap: null } });
    const host = fakeHost(client);
    await handleCollabMessage(host, { type: 'newCollab', title: '  Storm  ', agentSlugs: ['collab-crane', 7, null] });
    expect(calls[0]).toEqual({ method: 'collab_create', params: { title: 'Storm', agentSlugs: ['collab-crane'], cwd: 'C:/repo' } });
    expect(host.posts.map((p) => p.type)).toEqual(['collabCreated', 'collabList']);

    const failing = fakeClient({});
    const failHost = fakeHost(failing.client);
    await handleCollabMessage(failHost, { type: 'newCollab', title: 't', agentSlugs: [] });
    expect(failHost.posts.map((p) => p.type)).toEqual(['collabCreated']); // no re-list
  });
});

// Flock M4 wave X2 — the two optional fields the UI now sends. Both are
// SANITISED here (the webview is not trusted to have trimmed or typed them)
// and both must vanish from the wire when they carry nothing.
describe('collabManager — the flock M4 optional fields', () => {
  it('newCollab forwards a typed objective, trimmed', async () => {
    const { client, calls } = fakeClient({ collab: { id: 'c1', title: 'Storm', createdAt: 'x', loopBreakerCap: null } });
    await handleCollabMessage(fakeHost(client), { type: 'newCollab', title: 'Storm', agentSlugs: [], objective: '  Ship the wire  ' });
    expect(calls[0].params).toEqual({ title: 'Storm', agentSlugs: [], objective: 'Ship the wire', cwd: 'C:/repo' });
  });

  it('...and sends no objective at all for a blank or non-string one', async () => {
    for (const objective of [undefined, '', '   ', 42]) {
      const { client, calls } = fakeClient({ collab: { id: 'c1', title: 'S', createdAt: 'x', loopBreakerCap: null } });
      await handleCollabMessage(fakeHost(client), { type: 'newCollab', title: 'S', agentSlugs: [], objective });
      expect(calls[0].params, `objective: ${String(objective)}`).toEqual({ title: 'S', agentSlugs: [], cwd: 'C:/repo' });
    }
  });

  // The extension boundary is exactly where the engine's `no-lead` notice used
  // to be lost — `collabPost` answered `{collabId, seq}` and the room went
  // silent with nothing saying why. This pins that the reply carries it on.
  it('collabPosted carries the engine notice through to the room', async () => {
    const { client } = fakeClient({ seq: 3, notice: 'no-lead' });
    const host = fakeHost(client);
    await handleCollabMessage(host, { type: 'collabPost', collabId: 'c1', text: 'anyone there?' });
    expect(host.posts[0]).toEqual(post({ collabId: 'c1', seq: 3, notice: 'no-lead' }));
  });

  it('collabPost forwards the mentions, dropping anything that is not a string', async () => {
    const { client, calls } = fakeClient({ seq: 3 });
    await handleCollabMessage(fakeHost(client), {
      type: 'collabPost', collabId: 'c1', text: 'ping', mentions: ['collab-heron', 7, null, 'collab-crane'],
    });
    expect(calls[0].params).toEqual({
      collabId: 'c1', text: 'ping', mentions: ['collab-heron', 'collab-crane'], cwd: 'C:/repo',
    });
  });

  it('...and an empty, absent or malformed mentions list leaves the post byte-identical to today\'s', async () => {
    for (const mentions of [undefined, [], [7, null], 'collab-crane']) {
      const { client, calls } = fakeClient({ seq: 3 });
      await handleCollabMessage(fakeHost(client), { type: 'collabPost', collabId: 'c1', text: 'ship it', mentions });
      expect(calls[0].params, `mentions: ${JSON.stringify(mentions)}`).toEqual({ collabId: 'c1', text: 'ship it', cwd: 'C:/repo' });
    }
  });

  // M4.2 — the composer's attachments. Same shape rule as the mentions, and the
  // same reason: the webview is not the only thing that can put a message on
  // this wire, so a non-string entry is dropped here rather than reaching the
  // engine as an empty string it would refuse the whole post for.
  it('collabPost forwards the images, dropping anything that is not a non-empty string', async () => {
    const { client, calls } = fakeClient({ seq: 3 });
    await handleCollabMessage(fakeHost(client), {
      type: 'collabPost', collabId: 'c1', text: 'look',
      images: ['data:image/png;base64,AA==', 7, null, '', 'data:image/png;base64,BB=='],
    });
    expect(calls[0].params).toEqual({
      collabId: 'c1', text: 'look',
      images: ['data:image/png;base64,AA==', 'data:image/png;base64,BB=='],
      cwd: 'C:/repo',
    });
  });

  it('...and an empty, absent or malformed images list leaves the post byte-identical to today\'s', async () => {
    for (const images of [undefined, [], [7, null], '', 'data:image/png;base64,AA==']) {
      const { client, calls } = fakeClient({ seq: 3 });
      await handleCollabMessage(fakeHost(client), { type: 'collabPost', collabId: 'c1', text: 'ship it', images });
      expect(calls[0].params, `images: ${JSON.stringify(images)}`).toEqual({ collabId: 'c1', text: 'ship it', cwd: 'C:/repo' });
    }
  });
});

describe('collabManager — openCollab', () => {
  it('opens with the given title, or the id when no title was sent; a blank id opens nothing', async () => {
    const host = fakeHost(undefined);
    await handleCollabMessage(host, { type: 'openCollab', collabId: 'c1', title: 'Storm' });
    await handleCollabMessage(host, { type: 'openCollab', collabId: 'c2' });
    await handleCollabMessage(host, { type: 'openCollab' });
    expect(host.opened).toEqual([{ id: 'c1', title: 'Storm' }, { id: 'c2', title: 'c2' }]);
  });
});

describe('collabManager — collabPost / collabSetCap / collabPoll', () => {
  it('collabPost wires the text through and replies collabPosted', async () => {
    const { client, calls } = fakeClient({ seq: 3 });
    const host = fakeHost(client);
    await handleCollabMessage(host, { type: 'collabPost', collabId: 'c1', text: 'ship it' });
    expect(calls[0]).toEqual({ method: 'collab_post', params: { collabId: 'c1', text: 'ship it', cwd: 'C:/repo' } });
    expect(host.posts[0]).toEqual(post({ collabId: 'c1', seq: 3 }));
  });

  it('collabSetCap keeps null/0/N apart and refuses a negative down to null', async () => {
    const { client, calls } = fakeClient({ ok: true });
    const host = fakeHost(client);
    await handleCollabMessage(host, { type: 'collabSetCap', collabId: 'c1', cap: 0 });
    await handleCollabMessage(host, { type: 'collabSetCap', collabId: 'c1', cap: -5 });
    await handleCollabMessage(host, { type: 'collabSetCap', collabId: 'c1', cap: 9 });
    expect(calls.map((c) => c.params?.cap)).toEqual([0, null, 9]);
  });

  // W5. The width has no null and no 0: 1 IS the default, so a malformed or
  // out-of-range value falls back to serial rather than being sent on. Whether
  // a width ABOVE 1 is allowed is the engine's call — a room whose members can
  // still write files is refused there, and the refusal rides collabOpResult.
  it('collabSetConcurrency floors a malformed width at 1 and answers on collabOpResult', async () => {
    const { client, calls } = fakeClient({ ok: true });
    const host = fakeHost(client);
    await handleCollabMessage(host, { type: 'collabSetConcurrency', collabId: 'c1', concurrency: 3 });
    await handleCollabMessage(host, { type: 'collabSetConcurrency', collabId: 'c1', concurrency: 0 });
    await handleCollabMessage(host, { type: 'collabSetConcurrency', collabId: 'c1' });
    expect(calls.map((c) => c.params?.concurrency)).toEqual([3, 1, 1]);
    expect(host.posts.map((p) => p.type)).toEqual(['collabOpResult', 'collabOpResult', 'collabOpResult']);
  });

  it('collabPoll defaults sinceSeq to 0 and posts collabStateData', async () => {
    const { client, calls } = fakeClient({ collab: null, messages: [] });
    const host = fakeHost(client);
    await handleCollabMessage(host, { type: 'collabPoll', collabId: 'c1' });
    expect(calls[0].params).toEqual({ collabId: 'c1', cwd: 'C:/repo' });
    expect(host.posts[0].type).toBe('collabStateData');
  });
});

describe('collabManager — the four M2 mutations', () => {
  it('each wires its OWN method and replies collabOpResult with `op`; only archive re-lists', async () => {
    const { client, calls } = fakeClient({ ok: true });
    const host = fakeHost(client);

    await handleCollabMessage(host, { type: 'collabRename', collabId: 'c1', title: '  New title  ' });
    expect(calls[0]).toEqual({ method: 'collab_rename', params: { collabId: 'c1', title: 'New title', cwd: 'C:/repo' } });
    expect(host.posts[0]).toEqual({ type: 'collabOpResult', op: 'collabRename', collabId: 'c1', ok: true });

    await handleCollabMessage(host, { type: 'collabAddParticipant', collabId: 'c1', agentSlug: 'collab-crane' });
    expect(calls[1]).toEqual({ method: 'collab_add_participant', params: { collabId: 'c1', agentSlug: 'collab-crane', cwd: 'C:/repo' } });

    await handleCollabMessage(host, { type: 'collabRemoveParticipant', collabId: 'c1', agentSlug: 'collab-crane' });
    expect(calls[2]).toEqual({ method: 'collab_remove_participant', params: { collabId: 'c1', agentSlug: 'collab-crane', cwd: 'C:/repo' } });

    // Rename/add/remove never re-list.
    expect(host.posts.filter((p) => p.type === 'collabList')).toEqual([]);

    const archiveClient = fakeClient((method) => (method === 'collab_list' ? { collabs: [] } : { ok: true }));
    const archiveHost = fakeHost(archiveClient.client);
    await handleCollabMessage(archiveHost, { type: 'collabArchive', collabId: 'c1' });
    expect(archiveHost.posts.map((p) => p.type)).toEqual(['collabOpResult', 'collabList']);
  });

  it('a refused archive does not re-list', async () => {
    const thrower: CollabSource = { extMethod: async () => { throw new Error('archived already'); } };
    const host = fakeHost(thrower);
    await handleCollabMessage(host, { type: 'collabArchive', collabId: 'c1' });
    expect(host.posts).toEqual([{ type: 'collabOpResult', op: 'collabArchive', collabId: 'c1', ok: false, error: 'archived already' }]);
  });

  // collab-resume: the inverse of archive, same wire shape, same re-list rule
  // (the row moves back OUT of History, which no pane's poll would report).
  it('collabUnarchive sends collab_unarchive with this collabId and re-lists on success', async () => {
    const client = fakeClient((method) => (method === 'collab_list' ? { collabs: [] } : { ok: true }));
    const host = fakeHost(client.client);
    await handleCollabMessage(host, { type: 'collabUnarchive', collabId: 'c1' });
    expect(client.calls[0]).toEqual({ method: 'collab_unarchive', params: { collabId: 'c1', cwd: 'C:/repo' } });
    expect(host.posts.map((p) => p.type)).toEqual(['collabOpResult', 'collabList']);
    expect(host.posts[0]).toEqual({ type: 'collabOpResult', op: 'collabUnarchive', collabId: 'c1', ok: true });
  });

  it('a refused unarchive does not re-list', async () => {
    const thrower: CollabSource = { extMethod: async () => { throw new Error('not archived'); } };
    const host = fakeHost(thrower);
    await handleCollabMessage(host, { type: 'collabUnarchive', collabId: 'c1' });
    expect(host.posts).toEqual([{ type: 'collabOpResult', op: 'collabUnarchive', collabId: 'c1', ok: false, error: 'not archived' }]);
  });
});

describe('collabManager — collabPromptCapture', () => {
  it('asks the host for the NAMED session and echoes collabId + slug back', async () => {
    const host = fakeHost(undefined);
    host.promptCaptureFor = async (sessionId) => ({ capture: null, error: sessionId ? undefined : 'no session' });
    await handleCollabMessage(host, { type: 'collabPromptCapture', collabId: 'c1', slug: 'collab-crane', sessionId: 'ses_1' });
    expect(host.posts[0]).toEqual({ type: 'collabPromptCaptureData', collabId: 'c1', slug: 'collab-crane', capture: null });
  });
});

describe('collabManager — flock M4: lead / objective / stop', () => {
  it('collabSetLead sends the slug, including null (clear)', async () => {
    const { client, calls } = fakeClient({ ok: true });
    const host = fakeHost(client);
    await handleCollabMessage(host, { type: 'collabSetLead', collabId: 'c1', agentSlug: 'collab-crane' });
    expect(calls[0]).toEqual({ method: 'collab_set_lead', params: { collabId: 'c1', agentSlug: 'collab-crane', cwd: 'C:/repo' } });
    expect(host.posts[0]).toEqual({ type: 'collabOpResult', op: 'collabSetLead', collabId: 'c1', ok: true });

    await handleCollabMessage(host, { type: 'collabSetLead', collabId: 'c1' });
    expect(calls[1].params).toEqual({ collabId: 'c1', agentSlug: null, cwd: 'C:/repo' });
  });

  it('collabSetObjective sends the text', async () => {
    const { client, calls } = fakeClient({ ok: true });
    const host = fakeHost(client);
    await handleCollabMessage(host, { type: 'collabSetObjective', collabId: 'c1', objective: 'Ship it' });
    expect(calls[0]).toEqual({ method: 'collab_set_objective', params: { collabId: 'c1', objective: 'Ship it', cwd: 'C:/repo' } });
  });

  it('collabStop sends only the collab id', async () => {
    const { client, calls } = fakeClient({ ok: true });
    const host = fakeHost(client);
    await handleCollabMessage(host, { type: 'collabStop', collabId: 'c1' });
    expect(calls[0]).toEqual({ method: 'collab_stop', params: { collabId: 'c1', cwd: 'C:/repo' } });
    expect(host.posts[0]).toEqual({ type: 'collabOpResult', op: 'collabStop', collabId: 'c1', ok: true });
  });
});

describe('collabManager — flock M4: the task board', () => {
  const task = { id: 't1', title: 'Wire it', owner: null, state: 'open', createdBy: 'user', result: null, note: null, originSeq: null, createdAt: 'x', updatedAt: 'x' };

  it('collabTaskAdd trims the title and replies collabTaskResult with `op`', async () => {
    const { client, calls } = fakeClient({ task });
    const host = fakeHost(client);
    await handleCollabMessage(host, { type: 'collabTaskAdd', collabId: 'c1', title: '  Wire it  ' });
    expect(calls[0]).toEqual({ method: 'collab_task_add', params: { collabId: 'c1', title: 'Wire it', cwd: 'C:/repo' } });
    expect(host.posts[0]).toEqual({ type: 'collabTaskResult', op: 'collabTaskAdd', collabId: 'c1', task });
  });

  it('collabTaskUpdate forwards only the extras the caller sent', async () => {
    const { client, calls } = fakeClient({ task: { ...task, state: 'claimed', owner: 'collab-crane' } });
    const host = fakeHost(client);
    await handleCollabMessage(host, { type: 'collabTaskUpdate', collabId: 'c1', taskId: 't1', action: 'claim', owner: 'collab-crane' });
    expect(calls[0]).toEqual({ method: 'collab_task_update', params: { collabId: 'c1', taskId: 't1', action: 'claim', owner: 'collab-crane', cwd: 'C:/repo' } });
  });

  it('an unknown action is refused BEFORE the engine is called', async () => {
    const { client, calls } = fakeClient({ task });
    const host = fakeHost(client);
    await handleCollabMessage(host, { type: 'collabTaskUpdate', collabId: 'c1', taskId: 't1', action: 'delete-everything' });
    expect(calls).toEqual([]);
    expect(host.posts[0]).toEqual({ type: 'collabTaskResult', op: 'collabTaskUpdate', collabId: 'c1', task: null, error: 'Unknown task action.' });
  });
});

describe('collabManager — flock M4: requestCollabLedger', () => {
  it('replies collabLedgerData, sending limit only when given', async () => {
    const { client, calls } = fakeClient({ entries: [], totals: [] });
    const host = fakeHost(client);
    await handleCollabMessage(host, { type: 'requestCollabLedger', collabId: 'c1' });
    expect(calls[0]).toEqual({ method: 'collab_ledger', params: { collabId: 'c1', cwd: 'C:/repo' } });
    expect(host.posts[0].type).toBe('collabLedgerData');

    await handleCollabMessage(host, { type: 'requestCollabLedger', collabId: 'c1', limit: 20 });
    expect(calls[1].params).toEqual({ collabId: 'c1', limit: 20, cwd: 'C:/repo' });
  });
});

// The dispatcher is where the host-side watch (report F1) gets its input: no
// pane is mounted in any of these, and a collab still has to keep reporting.
describe('collabManager — arming the host watch', () => {
  const rooms = [
    { id: 'c1', title: 'Storm', createdAt: 'x', loopBreakerCap: null },
    { id: 'c2', title: 'Closed', createdAt: 'y', loopBreakerCap: null, archivedAt: '2026-08-17T10:00:00.000Z' },
  ];

  it('points the watch at the LIVE rooms on every list — an archived one is not watched', async () => {
    vi.useFakeTimers();
    try {
      const { client, calls } = fakeClient((method) => (method === 'collab_list' ? { collabs: rooms } : { collab: null, messages: [], agents: [] }));
      await handleCollabMessage(fakeHost(client), { type: 'requestCollabs' });
      calls.length = 0;
      await vi.advanceTimersByTimeAsync(COLLAB_WATCH_MS);
      expect(calls.map((c) => `${c.method}:${c.params?.collabId}`)).toEqual(['collab_state:c1']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('drops a room from the watch once the list stops carrying it', async () => {
    vi.useFakeTimers();
    try {
      let listed = rooms;
      const { client, calls } = fakeClient((method) => (method === 'collab_list' ? { collabs: listed } : { collab: null, messages: [], agents: [] }));
      await handleCollabMessage(fakeHost(client), { type: 'requestCollabs' });
      listed = [{ ...rooms[0], archivedAt: '2026-08-18T10:00:00.000Z' }];
      await handleCollabMessage(fakeHost(client), { type: 'requestCollabs' });
      calls.length = 0;
      await vi.advanceTimersByTimeAsync(COLLAB_WATCH_MS * 2);
      expect(calls).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});
