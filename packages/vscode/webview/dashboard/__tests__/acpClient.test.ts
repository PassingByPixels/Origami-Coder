// Origami U1/U2 — acpClient wire-contract unit tests.
//
// ALL fixtures here are authored FRESH against the new `origami/*`
// contract (docs/WIRE-CONTRACT.md). NO donor recorded event streams
// are imported — the donor fixtures encode the deleted `_meta.
// lilinyx_kind` smuggling + `nyx/*` notifications + Diarchy surface,
// which is exactly what U2 removes.
//
// These drive the real `buildClientImpl` decode + `extMethod` wrapper
// from src/acpClient.ts by injecting a fake `ClientSideConnection`, so
// we exercise the actual shipped wire logic, not a restatement of it.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { AcpClient, type AcpEventHandlers } from '../../../src/acpClient';

/** A no-op handler set; individual tests spy on the ones they assert. */
function makeHandlers(over: Partial<AcpEventHandlers> = {}): AcpEventHandlers {
  return {
    onAgentMessageChunk: vi.fn(),
    onAgentImageChunk: vi.fn(),
    onToolCallStart: vi.fn(),
    onToolCallUpdate: vi.fn(),
    onPermissionRequest: vi.fn(),
    onAvailableCommands: vi.fn(),
    onPlanStatus: vi.fn(),
    onPlanReady: vi.fn(),
    onBestOfNComplete: vi.fn(),
    onTaskShape: vi.fn(),
    onTodoUpdate: vi.fn(),
    onArbiterDecision: vi.fn(),
    onTurnEnd: vi.fn(),
    onAssessmentUpdate: vi.fn(),
    onFeedMessage: vi.fn(),
    onClose: vi.fn(),
    onError: vi.fn(),
    ...over,
  };
}

/** Build an AcpClient with a fake connection + a known session id so
 *  extMethod / session-scoped calls are exercisable without a binary. */
function clientWithFakeConnection(handlers: AcpEventHandlers, sessionId = 'sess-abc') {
  const client = new AcpClient(handlers);
  const extMethod = vi.fn(async () => ({}));
  // Inject private fields the methods read. Mirrors the donor test
  // style of casting to reach internals (ChatPane.test.ts etc.).
  (client as unknown as { connection: unknown }).connection = { extMethod };
  (client as unknown as { sessionId: string }).sessionId = sessionId;
  return { client, extMethod };
}

/** Reach the private `buildClientImpl()` to drive the decode directly. */
function buildImpl(client: AcpClient) {
  return (client as unknown as { buildClientImpl: () => any }).buildClientImpl();
}

describe('extMethod — `_`-prefix wire convention (SCAR UI-S4)', () => {
  it('sends `_<name>` for a bare method', async () => {
    const { client, extMethod } = clientWithFakeConnection(makeHandlers());
    await client.extMethod('list_agents');
    expect(extMethod).toHaveBeenCalledWith('_list_agents', {});
  });

  it('does NOT double-prefix an already-`_`-prefixed method', async () => {
    const { client, extMethod } = clientWithFakeConnection(makeHandlers());
    await client.extMethod('_already_prefixed', { a: 1 });
    expect(extMethod).toHaveBeenCalledWith('_already_prefixed', { a: 1 });
    // Real bug guard: dropping the prefix => every ext-method
    // `method_not_found`s; double-prefixing => same. Assert exactly one `_`.
    const wire = extMethod.mock.calls[0][0] as string;
    expect(wire.startsWith('__')).toBe(false);
  });
});

describe('model switching via ACP config-option (replaces dead list_models/set_active_model)', () => {
  it('setModel calls setSessionConfigOption(configId=model) and caches the refreshed options', async () => {
    const client = new AcpClient(makeHandlers());
    const setSessionConfigOption = vi.fn(async () => ({
      configOptions: [
        {
          id: 'model',
          type: 'select',
          currentValue: 'lmstudio/qwen-coder',
          options: [
            { value: 'lmstudio/qwen-coder', name: 'Qwen Coder' },
            { value: 'lmstudio/qwen-7b', name: 'Qwen 7B' },
          ],
        },
      ],
    }));
    (client as unknown as { connection: unknown }).connection = { setSessionConfigOption };
    (client as unknown as { sessionId: string }).sessionId = 'sess-xyz';

    const current = await client.setModel('lmstudio/qwen-coder');

    // The real ACP wire: configId='model', the chosen value, the session id.
    expect(setSessionConfigOption).toHaveBeenCalledWith({
      sessionId: 'sess-xyz',
      configId: 'model',
      value: 'lmstudio/qwen-coder',
    });
    expect(current).toBe('lmstudio/qwen-coder');
    // The picker now reads the server's refreshed configOptions — NOT a
    // dead list_models ext-method.
    expect(client.getModelOption()).toEqual({
      current: 'lmstudio/qwen-coder',
      options: [
        { value: 'lmstudio/qwen-coder', name: 'Qwen Coder' },
        { value: 'lmstudio/qwen-7b', name: 'Qwen 7B' },
      ],
    });
  });
});

// yolo-permissions: the engine now advertises the session's LIVE approve-mode
// as a scalar configOptions entry ({id:'permission', value}) alongside
// connect/resume/fork, so DashboardPanel can seed the composer from engine
// truth instead of the composer's own optimistic memory (broadcastConfigSelectors).
describe('getPermissionOption — configOptions scalar `permission` entry', () => {
  it('reads the live mode off the scalar entry (not a `select`, no options list)', () => {
    const client = new AcpClient(makeHandlers());
    (client as unknown as { configOptions: unknown[] }).configOptions = [{ id: 'permission', value: 'bypass' }];
    expect(client.getPermissionOption()).toBe('bypass');
  });

  it('is null when the engine does not advertise it — older engine, keep current behaviour', () => {
    const client = new AcpClient(makeHandlers());
    (client as unknown as { configOptions: unknown[] }).configOptions = [
      { id: 'model', type: 'select', currentValue: 'x', options: [] },
    ];
    expect(client.getPermissionOption()).toBeNull();
  });
});

describe('tool_call_update decode — honest status + diff (Channel-1)', () => {
  it('passes status `failed` through verbatim and extracts the diff content block', async () => {
    const handlers = makeHandlers();
    const impl = buildImpl(new AcpClient(handlers));
    await impl.sessionUpdate({
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tc1',
        status: 'failed',
        content: [
          { type: 'content', content: { type: 'text', text: 'patch did not apply' } },
          { type: 'diff', path: 'calc.py', oldText: 'a - b', newText: 'a + b' },
        ],
      },
    });
    // Guards the two real bugs: a `failed` status defaulting to
    // `completed` (the green-card sin), and the diff block being dropped
    // (edits with no before/after). Break either fix → this fails.
    expect(handlers.onToolCallUpdate).toHaveBeenCalledWith({
      toolCallId: 'tc1',
      status: 'failed',
      contentText: 'patch did not apply',
      diff: { path: 'calc.py', oldText: 'a - b', newText: 'a + b' },
    });
  });
});

describe('permission optionId round-trip (wire invariant once/always/reject)', () => {
  it('respond("once") resolves to outcome.selected with optionId "once"', async () => {
    const handlers = makeHandlers();
    let captured: { respond: (id: string | null) => void } | undefined;
    handlers.onPermissionRequest = vi.fn((args: any) => {
      captured = args;
    });
    const impl = buildImpl(new AcpClient(handlers));
    const resp = impl.requestPermission({
      toolCall: { toolCallId: 'tc1', title: 'Run bash', kind: 'execute' },
      options: [{ optionId: 'once', name: 'Allow once', kind: 'allow_once' }],
    });
    captured!.respond('once');
    // The protocol constant must reach the wire verbatim — a relabel of
    // the display name must NOT change the optionId, or an approval
    // silently becomes a reject.
    await expect(resp).resolves.toEqual({ outcome: { outcome: 'selected', optionId: 'once' } });
  });

  it('respond(null) resolves to a cancelled outcome', async () => {
    const handlers = makeHandlers();
    let captured: { respond: (id: string | null) => void } | undefined;
    handlers.onPermissionRequest = vi.fn((args: any) => {
      captured = args;
    });
    const impl = buildImpl(new AcpClient(handlers));
    const resp = impl.requestPermission({
      toolCall: { toolCallId: 'tc1', title: 'Run bash', kind: 'execute' },
      options: [{ optionId: 'once', name: 'Allow once', kind: 'allow_once' }],
    });
    captured!.respond(null);
    await expect(resp).resolves.toEqual({ outcome: { outcome: 'cancelled' } });
  });

  // M4.4 — a question answered in the user's own words. The text rides the
  // SELECTED outcome's `_meta`, which ACP reserves for exactly this.
  it('respond("other", text) puts the answer on the selected outcome\'s _meta', async () => {
    const handlers = makeHandlers();
    let captured: { respond: (id: string | null, answerText?: string) => void } | undefined;
    handlers.onPermissionRequest = vi.fn((args: any) => { captured = args; });
    const impl = buildImpl(new AcpClient(handlers));
    const resp = impl.requestPermission({
      toolCall: { toolCallId: 'tc-q', title: 'Which fix?', kind: 'other' },
      options: [{ optionId: 'other', name: 'Other', kind: 'allow_once' }],
    });
    captured!.respond('other', 'neither, revert it');
    await expect(resp).resolves.toEqual({
      outcome: { outcome: 'selected', optionId: 'other', _meta: { answerText: 'neither, revert it' } },
    });
  });

  it('an ordinary approval carries NO _meta key at all', async () => {
    // Not `_meta: undefined` — the key is ABSENT, so an engine that has never
    // heard of answerText receives byte-for-byte what it always received.
    const handlers = makeHandlers();
    let captured: { respond: (id: string | null, answerText?: string) => void } | undefined;
    handlers.onPermissionRequest = vi.fn((args: any) => { captured = args; });
    const impl = buildImpl(new AcpClient(handlers));
    const resp = impl.requestPermission({
      toolCall: { toolCallId: 'tc1', title: 'Run bash', kind: 'execute' },
      options: [{ optionId: 'once', name: 'Allow once', kind: 'allow_once' }],
    });
    captured!.respond('once');
    const out = (await resp) as { outcome: Record<string, unknown> };
    expect(Object.keys(out.outcome).sort()).toEqual(['optionId', 'outcome']);
  });

  it('a CANCEL is still a cancel even if text was somehow passed with it', async () => {
    // There is no such thing as a cancelled outcome carrying an answer; the
    // null branch returns before the text is ever consulted.
    const handlers = makeHandlers();
    let captured: { respond: (id: string | null, answerText?: string) => void } | undefined;
    handlers.onPermissionRequest = vi.fn((args: any) => { captured = args; });
    const impl = buildImpl(new AcpClient(handlers));
    const resp = impl.requestPermission({
      toolCall: { toolCallId: 'tc1', title: 'Run bash', kind: 'execute' },
      options: [{ optionId: 'once', name: 'Allow once', kind: 'allow_once' }],
    });
    captured!.respond(null, 'ignored');
    await expect(resp).resolves.toEqual({ outcome: { outcome: 'cancelled' } });
  });

  // A BATCHED clarifying ask: the engine puts every question on the request's
  // `_meta.questions` (packages/engine/src/acp/question.ts) and reads every
  // answer back off the outcome's `_meta.answers`. This is the seam where those
  // two `_meta` bags become, and come from, the handler's own arguments.
  const batchAsk = {
    toolCall: { toolCallId: 'tc-batch', title: 'Which parser?', kind: 'other' },
    options: [
      { optionId: '0', name: 'Rewrite it', kind: 'allow_once' },
      { optionId: '1', name: 'Other', kind: 'reject_once' },
    ],
    _meta: {
      questions: [
        { question: 'Which parser?', header: 'Parser', options: [
          { optionId: '0', kind: 'allow_once', name: 'Rewrite it' },
          { optionId: '1', kind: 'reject_once', name: 'Other' },
        ] },
        { question: 'Which store?', header: 'Store', options: [
          { optionId: '0', kind: 'allow_once', name: 'SQLite' },
          { optionId: '1', kind: 'reject_once', name: 'Other' },
        ] },
      ],
    },
  };

  it('hands the whole batch to the handler as `questions`', async () => {
    const handlers = makeHandlers();
    let captured: any;
    handlers.onPermissionRequest = vi.fn((args: any) => { captured = args; });
    const impl = buildImpl(new AcpClient(handlers));
    const resp = impl.requestPermission(batchAsk);
    expect(captured.questions.map((q: any) => q.title)).toEqual(['Which parser?', 'Which store?']);
    // title/options still describe question 1, so nothing that ignores the
    // batch sees a different ask than it saw before batching existed.
    expect(captured.title).toBe('Which parser?');
    captured.respond('0');
    await resp;
  });

  it('an ask with NO _meta.questions leaves `questions` undefined', async () => {
    const handlers = makeHandlers();
    let captured: any;
    handlers.onPermissionRequest = vi.fn((args: any) => { captured = args; });
    const impl = buildImpl(new AcpClient(handlers));
    const resp = impl.requestPermission({
      toolCall: { toolCallId: 'tc1', title: 'Run bash', kind: 'execute' },
      options: [{ optionId: 'once', name: 'Allow once', kind: 'allow_once' }],
    });
    expect(captured.questions).toBeUndefined();
    captured.respond('once');
    await resp;
  });

  it('respond(..., answers) puts the whole batch on the outcome\'s _meta.answers', async () => {
    const handlers = makeHandlers();
    let captured: any;
    handlers.onPermissionRequest = vi.fn((args: any) => { captured = args; });
    const impl = buildImpl(new AcpClient(handlers));
    const resp = impl.requestPermission(batchAsk);
    captured.respond('0', undefined, [{ optionId: '0' }, { optionId: '1', answerText: 'Postgres' }]);
    await expect(resp).resolves.toEqual({
      outcome: {
        outcome: 'selected',
        optionId: '0',
        _meta: { answers: [{ optionId: '0' }, { optionId: '1', answerText: 'Postgres' }] },
      },
    });
  });

  it('cancelling a BATCH is a plain cancelled outcome, carrying no answers', async () => {
    // The engine reads this as "the user declined" and completes the tool call
    // rather than waiting; anything else would leave the turn blocked.
    const handlers = makeHandlers();
    let captured: any;
    handlers.onPermissionRequest = vi.fn((args: any) => { captured = args; });
    const impl = buildImpl(new AcpClient(handlers));
    const resp = impl.requestPermission(batchAsk);
    captured.respond(null, undefined, [{ optionId: '0' }]);
    await expect(resp).resolves.toEqual({ outcome: { outcome: 'cancelled' } });
  });
});

describe('first-class origami/* notification decode (U2)', () => {
  let handlers: AcpEventHandlers;
  let impl: any;

  beforeEach(() => {
    handlers = makeHandlers();
    impl = buildImpl(new AcpClient(handlers));
  });

  it('origami/todoSnapshot → onTodoUpdate with coerced fields', async () => {
    await impl.extNotification('_origami/todoSnapshot', {
      source: 'model_write',
      todos: [{ id: 1, content: 'write parser', activeForm: 'Writing parser', status: 'in_progress' }],
    });
    expect(handlers.onTodoUpdate).toHaveBeenCalledWith({
      source: 'model_write',
      // A snapshot with no depth on it reads as a flat list, which is what every
      // list looked like before nesting existed.
      todos: [{ id: 1, content: 'write parser', activeForm: 'Writing parser', status: 'in_progress', depth: 0 }],
    });
  });

  it('origami/todoSnapshot carries depth — the RESTORE feed is nested too, not only the live one', async () => {
    await impl.extNotification('_origami/todoSnapshot', {
      source: 'session_restore',
      todos: [
        { id: 0, content: 'parent', activeForm: 'parent', status: 'in_progress', depth: 0 },
        { id: 1, content: 'child', activeForm: 'child', status: 'completed', depth: 1 },
        // Garbage stays a row; it just loses its indent.
        { id: 2, content: 'junk', activeForm: 'junk', status: 'pending', depth: 'deep' },
      ],
    });
    expect(handlers.onTodoUpdate).toHaveBeenCalledWith({
      source: 'session_restore',
      todos: [
        { id: 0, content: 'parent', activeForm: 'parent', status: 'in_progress', depth: 0 },
        { id: 1, content: 'child', activeForm: 'child', status: 'completed', depth: 1 },
        { id: 2, content: 'junk', activeForm: 'junk', status: 'pending', depth: 0 },
      ],
    });
  });

  it('origami/arbiterDecision → onArbiterDecision (the M1 per-turn verdict)', async () => {
    await impl.extNotification('_origami/arbiterDecision', { decision: 'done', reason: 'tests green' });
    expect(handlers.onArbiterDecision).toHaveBeenCalledWith({ decision: 'done', reason: 'tests green' });
  });

  it('origami/turnEnd → onPlanStatus with status `turn_end` (NOT self_review)', async () => {
    await impl.extNotification('_origami/turnEnd', { stop_reason: 'success' });
    expect(handlers.onPlanStatus).toHaveBeenCalledWith({
      planId: '',
      status: 'turn_end',
      revisionCount: 0,
    });
    // The phantom-banner path is gone: turn_end never dispatches a
    // 'self_review' status.
    const statuses = (handlers.onPlanStatus as any).mock.calls.map((c: any[]) => c[0].status);
    expect(statuses).not.toContain('self_review');
  });

  it('origami/turnEnd FORWARDS the real stop_reason via onTurnEnd (no longer discarded)', async () => {
    // The F4 fix: the stop_reason payload was thrown away (only the
    // banner was cleared), so a budget-walled FAILURE looked like
    // healthy progress. It must now reach onTurnEnd verbatim.
    await impl.extNotification('_origami/turnEnd', { stop_reason: 'error_max_turns' });
    expect(handlers.onTurnEnd).toHaveBeenCalledWith({ stopReason: 'error_max_turns' });
  });

  it('renamed feed/assessment notifications route to their handlers', async () => {
    await impl.extNotification('_origami/feedMessage', { bus_kind: 'tick', epoch_secs: 42 });
    await impl.extNotification('_origami/assessmentUpdate', { toolCallId: 't1', text: 'ok' });
    expect(handlers.onFeedMessage).toHaveBeenCalledWith({
      busKind: 'tick',
      payload: { bus_kind: 'tick', epoch_secs: 42 },
    });
    expect(handlers.onAssessmentUpdate).toHaveBeenCalledWith({ toolCallId: 't1', text: 'ok' });
  });
});

describe('prompt() usage — the cache-write field the cast used to drop (t-kgtw47)', () => {
  it('forwards cachedWriteTokens from the prompt response into onUsageUpdate', async () => {
    const handlers = makeHandlers();
    const client = new AcpClient(handlers);
    const prompt = vi.fn(async () => ({
      stopReason: 'end_turn',
      usage: { inputTokens: 30, cachedReadTokens: 12, cachedWriteTokens: 44, outputTokens: 18 },
    }));
    (client as unknown as { connection: unknown }).connection = { prompt };
    (client as unknown as { sessionId: string }).sessionId = 'sess-cache';
    handlers.onUsageUpdate = vi.fn();

    await client.prompt('hi');

    expect(handlers.onUsageUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ cacheReadTokens: 12, cacheWriteTokens: 44, outputTokens: 18 }),
    );
  });

  it('a response with no cachedWriteTokens at all reports 0, not undefined', async () => {
    const handlers = makeHandlers();
    const client = new AcpClient(handlers);
    const prompt = vi.fn(async () => ({
      stopReason: 'end_turn',
      usage: { inputTokens: 30, cachedReadTokens: 12, outputTokens: 18 },
    }));
    (client as unknown as { connection: unknown }).connection = { prompt };
    (client as unknown as { sessionId: string }).sessionId = 'sess-nowrite';
    handlers.onUsageUpdate = vi.fn();

    await client.prompt('hi');

    expect(handlers.onUsageUpdate).toHaveBeenCalledWith(expect.objectContaining({ cacheWriteTokens: 0 }));
  });
});

describe('no event rides Plan / no phantom self-review (U2)', () => {
  it('a synthetic Plan-shaped event is NOT decoded as a domain event', async () => {
    const handlers = makeHandlers();
    const impl = buildImpl(new AcpClient(handlers));
    // The donor smuggled todo/turn_end/etc through `Plan` + `_meta.
    // lilinyx_kind`. Feed such a synthetic Plan and assert NONE of the
    // promoted handlers fire from the Plan path — they only fire from
    // first-class origami/* notifications.
    await impl.sessionUpdate({
      update: {
        sessionUpdate: 'plan',
        _meta: { lilinyx: true, lilinyx_kind: 'todo', todos: [{ id: 9, content: 'x', status: 'pending' }] },
      },
    });
    expect(handlers.onTodoUpdate).not.toHaveBeenCalled();
    expect(handlers.onPlanStatus).not.toHaveBeenCalled(); // no status field → nothing dispatched
    // A REAL plan (status awaiting_user) still routes to onPlanReady.
    await impl.sessionUpdate({
      update: { sessionUpdate: 'plan', _meta: { status: 'awaiting_user', planId: 'P1', title: 'Build' } },
    });
    expect(handlers.onPlanReady).toHaveBeenCalledWith(
      expect.objectContaining({ planId: 'P1', title: 'Build', status: 'awaiting_user' }),
    );
  });
});

// `annotations.audience` — replayed content the MODEL reads and the human must not.
//
// The engine writes parts flagged `synthetic` (the interject ENVELOPE, plan-mode
// preambles, a background sub-agent's `<task_result>` blob, compaction scratch).
// The LIVE path never emits them — run-steps.ts:276 returns undefined for
// `part.synthetic || part.ignored`, and acp/event.ts:369-373 forwards a live user
// text part only when it carries a peer rider. REPLAY does not filter: on
// `session/load`, acp/event.ts:262-288 pushes every part through
// partsToContentChunks, and acp/content.ts:123-135 + 253-257 stamps a synthetic
// text part with `annotations: { audience: ['assistant'] }` rather than dropping
// it. So a reloaded chat rendered the model's own instructions as the human's
// words. The fixtures below are that exact wire shape, not an invented one.
//
// The inverse flag exists too: `ignored` ⇒ `audience: ['user']` — text the human
// sees and the model does not. It must still render, which is why the rule is
// "audience excludes the user", not "audience is present".

/** The engine's real interject envelope (packages/engine/src/origami/interject.ts). */
const ENVELOPE =
  '[The user sent this message while you were working. Address it, then continue your current task unless it changes your instructions.]';

describe('replayed content honours annotations.audience', () => {
  it('drops the interject ENVELOPE from a replayed user turn but keeps what the user typed', async () => {
    const onUserMessageChunk = vi.fn();
    const impl = buildImpl(new AcpClient(makeHandlers({ onUserMessageChunk })));
    // Both parts of ONE interjected user message, in the order prompt.ts writes
    // them (envelope first, then the user's text — session/prompt.ts:1599-1613).
    await impl.sessionUpdate({
      update: {
        sessionUpdate: 'user_message_chunk',
        messageId: 'msg_1',
        content: { type: 'text', text: ENVELOPE, annotations: { audience: ['assistant'] } },
      },
    });
    await impl.sessionUpdate({
      update: {
        sessionUpdate: 'user_message_chunk',
        messageId: 'msg_1',
        content: { type: 'text', text: 'stop and explain' },
      },
    });
    expect(onUserMessageChunk).toHaveBeenCalledTimes(1);
    expect(onUserMessageChunk).toHaveBeenCalledWith('stop and explain');
    expect(onUserMessageChunk).not.toHaveBeenCalledWith(ENVELOPE);
  });

  it('drops a synthetic ASSISTANT part on replay — the same leak, one slot over', async () => {
    const handlers = makeHandlers();
    const impl = buildImpl(new AcpClient(handlers));
    // A background sub-agent's result turn (tool/task.ts:470) is written
    // synthetic: the model reads the blob, the human reads the prose after it.
    await impl.sessionUpdate({
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: {
          type: 'text',
          text: '<task_result session="ses_x">…</task_result>',
          annotations: { audience: ['assistant'] },
        },
      },
    });
    expect(handlers.onAgentMessageChunk).not.toHaveBeenCalled();

    await impl.sessionUpdate({
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Done — 3 files changed.' } },
    });
    expect(handlers.onAgentMessageChunk).toHaveBeenCalledWith('Done — 3 files changed.', undefined);
  });

  it('KEEPS text addressed to the user (`ignored` parts replay as audience:["user"])', async () => {
    const onUserMessageChunk = vi.fn();
    const impl = buildImpl(new AcpClient(makeHandlers({ onUserMessageChunk })));
    await impl.sessionUpdate({
      update: {
        sessionUpdate: 'user_message_chunk',
        content: { type: 'text', text: 'for your eyes only', annotations: { audience: ['user'] } },
      },
    });
    expect(onUserMessageChunk).toHaveBeenCalledWith('for your eyes only');
  });

  it('fails OPEN on a half-formed rider — losing a turn the human typed is worse than one stray line', async () => {
    const onUserMessageChunk = vi.fn();
    const impl = buildImpl(new AcpClient(makeHandlers({ onUserMessageChunk })));
    for (const annotations of [undefined, {}, { audience: [] }, { audience: 'assistant' }, { audience: null }]) {
      await impl.sessionUpdate({
        update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'real words', annotations } },
      });
    }
    expect(onUserMessageChunk).toHaveBeenCalledTimes(5);
  });

  it('still routes a PEER handoff, and still does not route a model-only one as the human', async () => {
    const onPeerMessage = vi.fn();
    const onUserMessageChunk = vi.fn();
    const impl = buildImpl(new AcpClient(makeHandlers({ onPeerMessage, onUserMessageChunk })));
    await impl.sessionUpdate({
      update: {
        sessionUpdate: 'user_message_chunk',
        content: { type: 'text', text: 'handing over' },
        _meta: { origami_peer: { from: 'Scout', replyTo: 'Scout#ses_1' } },
      },
    });
    expect(onPeerMessage).toHaveBeenCalledWith({ from: 'Scout', replyTo: 'Scout#ses_1', text: 'handing over' });
    expect(onUserMessageChunk).not.toHaveBeenCalled();
  });
});
