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
    onFlockMailbox: vi.fn(),
    onArtifactsChanged: vi.fn(),
    onCacheState: vi.fn(),
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

  it('origami/cacheState → onCacheState, window and all', async () => {
    await impl.extNotification('_origami/cacheState', {
      sessionId: 'sess-abc', state: 'warm', until: 1_700_000_300_000, ttlSeconds: 300, source: 'request',
    });
    expect(handlers.onCacheState).toHaveBeenCalledWith({
      sessionId: 'sess-abc', state: 'warm', until: 1_700_000_300_000, ttlSeconds: 300, source: 'request',
    });
  });

  // A provider that publishes no window sends no `until`, and the decode must
  // not manufacture one: a zero would render as a countdown that already ran out.
  it('origami/cacheState with no window keeps until/ttlSeconds ABSENT', async () => {
    await impl.extNotification('_origami/cacheState', {
      sessionId: 'sess-abc', state: 'warm', source: 'request',
    });
    const push = (handlers.onCacheState as any).mock.calls[0][0];
    expect(push).toEqual({ sessionId: 'sess-abc', state: 'warm', source: 'request' });
    expect('until' in push).toBe(false);
    expect('ttlSeconds' in push).toBe(false);
  });

  it('origami/cacheState with an unknown state falls to unmeasured, and a push with no session id is dropped', async () => {
    await impl.extNotification('_origami/cacheState', { sessionId: 'sess-abc', state: 'toasty', source: 'warm' });
    expect(handlers.onCacheState).toHaveBeenCalledWith({
      sessionId: 'sess-abc', state: 'unmeasured', source: 'warm',
    });
    (handlers.onCacheState as any).mockClear();
    await impl.extNotification('_origami/cacheState', { state: 'cold', source: 'request' });
    expect(handlers.onCacheState).not.toHaveBeenCalled();
  });

  it('origami/arbiterDecision → onArbiterDecision (the M1 per-turn verdict)', async () => {
    await impl.extNotification('_origami/arbiterDecision', { decision: 'done', reason: 'tests green' });
    expect(handlers.onArbiterDecision).toHaveBeenCalledWith({ decision: 'done', reason: 'tests green' });
  });

  // PUSH, NOT POLL. `flock.json` moved in some engine on this machine and the
  // engine said so; before this the pane learned about a reply by asking every
  // thirty seconds. Asserted on the COUNTS as well as the rows, because the
  // sidebar badge does arithmetic with them.
  it('origami/flockMailbox → onFlockMailbox, rows verbatim and counts coerced', async () => {
    const threads = [{ id: 't1', direction: 'in', state: 'pending' }];
    await impl.extNotification('_origami/flockMailbox', { threads, waiting: 1, unread: 2 });
    expect(handlers.onFlockMailbox).toHaveBeenCalledWith({ threads, waiting: 1, unread: 2 });
  });

  it('a malformed flockMailbox payload renders an EMPTY mailbox, never NaN counts', async () => {
    await impl.extNotification('_origami/flockMailbox', { threads: 'not an array', waiting: 'x' });
    expect(handlers.onFlockMailbox).toHaveBeenCalledWith({ threads: [], waiting: 0, unread: 0 });
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

// t-q90gj9 — a dropped provider stream. The engine used to say this as agent
// PROSE; it is a rider on an EMPTY agent_message_chunk now, and the host must
// route it away from the transcript before anything can render it as the agent.
describe('the stream-drop rider', () => {
  const chunk = (meta: unknown) => ({
    update: {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: '' },
      _meta: meta,
    },
  });

  it('routes a whole notice to onStreamDrop and NOT to the transcript', async () => {
    const handlers = makeHandlers({ onStreamDrop: vi.fn() });
    const impl = buildImpl(new AcpClient(handlers));
    await impl.sessionUpdate(chunk({
      origami_stream_drop: {
        kind: 'retrying', attempt: 2, max: 3, detail: 'fetch failed (ECONNRESET)', terminal: false,
      },
    }));
    expect(handlers.onStreamDrop).toHaveBeenCalledWith({
      kind: 'retrying', attempt: 2, max: 3, detail: 'fetch failed (ECONNRESET)', terminal: false,
    });
    // The whole point: it never reaches the agent bubble.
    expect(handlers.onAgentMessageChunk).not.toHaveBeenCalled();
  });

  it('marks a stopped notice terminal, which is the card that offers Retry', async () => {
    const handlers = makeHandlers({ onStreamDrop: vi.fn() });
    const impl = buildImpl(new AcpClient(handlers));
    await impl.sessionUpdate(chunk({
      origami_stream_drop: { kind: 'stopped', attempt: 3, max: 3, detail: 'idle timeout' },
    }));
    expect(handlers.onStreamDrop).toHaveBeenCalledWith(expect.objectContaining({ terminal: true }));
  });

  // Fail-closed. A half-written rider must draw NO card - and it must not fall
  // through into an empty agent bubble either.
  it('ignores a rider missing its detail', async () => {
    const handlers = makeHandlers({ onStreamDrop: vi.fn() });
    const impl = buildImpl(new AcpClient(handlers));
    await impl.sessionUpdate(chunk({ origami_stream_drop: { kind: 'retrying', attempt: 1, max: 3 } }));
    expect(handlers.onStreamDrop).not.toHaveBeenCalled();
  });

  // An engine that still sends the OLD text form keeps working: it is ordinary
  // agent prose here, matched by nothing. Replacing it is the ENGINE's job.
  it('leaves the old text form as an ordinary agent chunk', async () => {
    const handlers = makeHandlers({ onStreamDrop: vi.fn() });
    const impl = buildImpl(new AcpClient(handlers));
    await impl.sessionUpdate({
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Stream dropped (fetch failed) - retrying, attempt 1 of 3.' },
      },
    });
    expect(handlers.onStreamDrop).not.toHaveBeenCalled();
    expect(handlers.onAgentMessageChunk).toHaveBeenCalledWith(
      'Stream dropped (fetch failed) - retrying, attempt 1 of 3.',
      undefined,
    );
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

// t-dkkd2o. A BACKGROUND sub-agent's launcher tool call completes the instant
// the child is spawned, so its counters can no longer ride a `tool_call_update`.
// The engine posts them on an empty chunk tagged with the child's session id.
describe('sub-agent token counters — the running child`s side channel', () => {
  it('routes a counters-only chunk to onSubagentTokens and renders nothing', async () => {
    const onSubagentTokens = vi.fn();
    const handlers = makeHandlers({ onSubagentTokens });
    const impl = buildImpl(new AcpClient(handlers));
    await impl.sessionUpdate({
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: '' },
        _meta: {
          origami_task_session: 'ses_child',
          origami_task_tokens: { input: 16_077, output: 46, reasoning: 47, cacheRead: 0, cacheWrite: 0, cost: 0 },
        },
      },
    });
    expect(onSubagentTokens).toHaveBeenCalledWith({
      childSessionId: 'ses_child',
      tokens: { input: 16_077, output: 46, reasoning: 47, cacheRead: 0, cacheWrite: 0, cost: 0 },
    });
    // An empty bubble in the parent transcript per child step is the failure
    // this branch exists to prevent.
    expect(handlers.onAgentMessageChunk).not.toHaveBeenCalled();
  });

  it('reads BOTH riders off the settling chunk: the final total and the terminal marker', async () => {
    const onSubagentTokens = vi.fn();
    const onSubagentDone = vi.fn();
    const impl = buildImpl(new AcpClient(makeHandlers({ onSubagentTokens, onSubagentDone })));
    await impl.sessionUpdate({
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: '' },
        _meta: {
          origami_task_session: 'ses_child',
          origami_task_state: 'completed',
          origami_task_ended: 1_789_425_347_621,
          origami_task_tokens: { input: 46_724, output: 96, reasoning: 58, cacheRead: 0, cacheWrite: 0, cost: 0 },
        },
      },
    });
    // The settled figure must land BEFORE the row is retired, or the row keeps
    // whatever the last live step reported.
    expect(onSubagentTokens).toHaveBeenCalledWith({
      childSessionId: 'ses_child',
      tokens: { input: 46_724, output: 96, reasoning: 58, cacheRead: 0, cacheWrite: 0, cost: 0 },
    });
    // The marker carries the final total TOO (t-fdvr2a): it is the only
    // sub-agent frame the host writes to the message log, so a figure left on
    // the live channel alone does not survive a window reload.
    expect(onSubagentDone).toHaveBeenCalledWith({
      taskSessionId: 'ses_child',
      state: 'completed',
      endedAt: 1_789_425_347_621,
      tokens: { input: 46_724, output: 96, reasoning: 58, cacheRead: 0, cacheWrite: 0, cost: 0 },
    });
  });

  it('a marker from an engine that rides no counters carries no `tokens` key', async () => {
    // The host keeps the last live figure when the marker has none
    // (sessionLogSubagent.ts); a `tokens: undefined` rider would read the same
    // way here, but the absent key is what makes that rule readable.
    const onSubagentDone = vi.fn();
    const impl = buildImpl(new AcpClient(makeHandlers({ onSubagentDone })));
    await impl.sessionUpdate({
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: '' },
        _meta: { origami_task_session: 'ses_child', origami_task_state: 'error' },
      },
    });
    expect(onSubagentDone).toHaveBeenCalledWith({ taskSessionId: 'ses_child', state: 'error' });
    expect(Object.keys(onSubagentDone.mock.calls[0][0])).not.toContain('tokens');
  });

  it('leaves an ordinary forwarded child chunk alone', async () => {
    const onSubagentTokens = vi.fn();
    const onSubagentChunk = vi.fn();
    const impl = buildImpl(new AcpClient(makeHandlers({ onSubagentTokens, onSubagentChunk })));
    await impl.sessionUpdate({
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: '> bash\n' },
        _meta: { origami_child_session: 'ses_child' },
      },
    });
    expect(onSubagentTokens).not.toHaveBeenCalled();
    expect(onSubagentChunk).toHaveBeenCalledWith({ childSessionId: 'ses_child', text: '> bash\n' });
  });

  // t-gvz8t0. The child's THOUGHT rides the same channel with one extra key.
  // Routed apart from its prose because `onSubagentChunk` writes `taskStream`,
  // which is the row's activity tail AND the transcript card's reply text.
  it('routes a chunk MARKED as reasoning to the thought handler, never to the stream', async () => {
    const onSubagentChunk = vi.fn();
    const onSubagentThought = vi.fn();
    const impl = buildImpl(new AcpClient(makeHandlers({ onSubagentChunk, onSubagentThought })));
    await impl.sessionUpdate({
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'weighing two approaches' },
        _meta: { origami_child_session: 'ses_child', origami_task_part: 'reasoning' },
      },
    });
    expect(onSubagentThought).toHaveBeenCalledWith({ childSessionId: 'ses_child', text: 'weighing two approaches' });
    expect(onSubagentChunk).not.toHaveBeenCalled();
  });

  it('treats an UNKNOWN part marker as prose — a marker cannot hide a line', async () => {
    const onSubagentChunk = vi.fn();
    const onSubagentThought = vi.fn();
    const impl = buildImpl(new AcpClient(makeHandlers({ onSubagentChunk, onSubagentThought })));
    await impl.sessionUpdate({
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: '> bash\n' },
        _meta: { origami_child_session: 'ses_child', origami_task_part: 'something_new' },
      },
    });
    expect(onSubagentChunk).toHaveBeenCalledWith({ childSessionId: 'ses_child', text: '> bash\n' });
    expect(onSubagentThought).not.toHaveBeenCalled();
  });
});

// t-gw71a9. The todo panel must fill in the moment the model writes the list,
// even when the call is batched behind two sub-agent spawns in the same step.
// The engine now publishes every parsed call in a step before it runs any of
// them, so the todowrite's list is on the wire while the spawns are still
// going. These pin the client end of that: whichever frame of the lifecycle
// carries `rawInput.todos` first, the strip is updated from it and no generic
// tool card leaks.
describe('todowrite — the list is taken from the FIRST frame that carries it (t-gw71a9)', () => {
  const TODOS = [
    { content: 'read the ticket', status: 'in_progress', priority: 'high' },
    { content: 'write the test', status: 'pending', priority: 'high' },
  ];
  const ROWS = [
    { id: 0, content: 'read the ticket', activeForm: 'read the ticket', status: 'in_progress', depth: 0 },
    { id: 1, content: 'write the test', activeForm: 'write the test', status: 'pending', depth: 0 },
  ];

  it('a PENDING tool_call carrying rawInput.todos posts todoUpdate and renders no card', async () => {
    const handlers = makeHandlers();
    const impl = buildImpl(new AcpClient(handlers));
    await impl.sessionUpdate({
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'call_todo',
        title: 'todowrite',
        kind: 'other',
        status: 'pending',
        rawInput: { todos: TODOS },
        _meta: { origami_tool_name: 'todowrite' },
      },
    });
    expect(handlers.onTodoUpdate).toHaveBeenCalledWith({ source: 'model_write', todos: ROWS });
    // The strip owns this tool; a generic card beside it would double-render it.
    expect(handlers.onToolCallStart).not.toHaveBeenCalled();
  });

  it('the RUNNING tool_call_update carrying the list posts it too — that is the frame the engine sends first', async () => {
    const handlers = makeHandlers();
    const impl = buildImpl(new AcpClient(handlers));
    // The pending frame the engine really sends has an EMPTY input: the part is
    // created before its arguments are parsed. It must still be swallowed, and
    // must not post an empty list.
    await impl.sessionUpdate({
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'call_todo',
        title: 'todowrite',
        kind: 'other',
        status: 'pending',
        rawInput: {},
        _meta: { origami_tool_name: 'todowrite' },
      },
    });
    expect(handlers.onTodoUpdate).not.toHaveBeenCalled();
    expect(handlers.onToolCallStart).not.toHaveBeenCalled();

    await impl.sessionUpdate({
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'call_todo',
        status: 'in_progress',
        rawInput: { todos: TODOS },
      },
    });
    expect(handlers.onTodoUpdate).toHaveBeenCalledWith({ source: 'model_write', todos: ROWS });
    expect(handlers.onToolCallUpdate).not.toHaveBeenCalled();
  });
});

describe('the artifact ext methods — the wire contract the pane codes against (t-rz3gfr)', () => {
  // DRIFT GUARD. These five names and their parameter fields are the engine's
  // `acp/artifacts.ts` switch arms; the pane's own copy of the same contract
  // lives in src/dashboard/artifactAcp.ts. A rename on either side that is not
  // made on the other turns into "method not found" at runtime, on a pane that
  // then draws its empty state and looks merely empty. Asserted on the WIRE
  // call, because that is the thing both sides actually share.
  it('sends each method under its wire name, with only the fields the engine reads', async () => {
    const { client, extMethod } = clientWithFakeConnection(makeHandlers());

    await client.listArtifacts();
    expect(extMethod).toHaveBeenLastCalledWith('_artifact_list', {});
    await client.listArtifacts({ all: true, projectPath: 'C:/Repos/x' });
    expect(extMethod).toHaveBeenLastCalledWith('_artifact_list', { all: true, projectPath: 'C:/Repos/x' });

    await client.listArtifactVersions('art_1');
    expect(extMethod).toHaveBeenLastCalledWith('_artifact_versions', { artifactId: 'art_1' });

    // No version means the LATEST, and the field is omitted rather than sent
    // as null — the engine rejects a version that is not a whole number.
    await client.openArtifact('art_1');
    expect(extMethod).toHaveBeenLastCalledWith('_artifact_open', { artifactId: 'art_1' });
    await client.openArtifact('art_1', 2);
    expect(extMethod).toHaveBeenLastCalledWith('_artifact_open', { artifactId: 'art_1', version: 2 });

    await client.restoreArtifact('art_1', 1);
    expect(extMethod).toHaveBeenLastCalledWith('_artifact_restore', { artifactId: 'art_1', version: 1 });

    await client.diffArtifact('art_1', 1, 3);
    expect(extMethod).toHaveBeenLastCalledWith('_artifact_diff', { artifactId: 'art_1', from: 1, to: 3 });
  });

  it('passes the engine result through with the row fields the pane reads', async () => {
    const client = new AcpClient(makeHandlers());
    const row = {
      id: 'art_1',
      title: 'Release notes',
      latest: 2,
      updated: 1700000000000,
      ownerDevice: '5090',
      here: true,
      unopened: false,
      sessionID: 'ses_1',
      project: 'C:/Repos/x',
    };
    (client as unknown as { connection: unknown }).connection = {
      extMethod: async () => ({ artifacts: [row], homeDevice: 'this machine' }),
    };
    const result = await client.listArtifacts();
    expect(result.artifacts[0]).toEqual(row);
    expect(result.homeDevice).toBe('this machine');
  });

  it('origami/artifactsChanged → onArtifactsChanged, renderable whatever arrives', async () => {
    const handlers = makeHandlers();
    const impl = buildImpl(new AcpClient(handlers));
    await impl.extNotification('_origami/artifactsChanged', { artifactId: 'art_1', version: 3, kind: 'published' });
    expect(handlers.onArtifactsChanged).toHaveBeenCalledWith({ artifactId: 'art_1', version: 3, kind: 'published' });
    // A prune carries no version; a garbled frame must still not poison the pane.
    await impl.extNotification('_origami/artifactsChanged', { artifactId: 'art_2', kind: 'pruned' });
    expect(handlers.onArtifactsChanged).toHaveBeenLastCalledWith({ artifactId: 'art_2', kind: 'pruned' });
    await impl.extNotification('_origami/artifactsChanged', { artifactId: 7, version: 'x' });
    expect(handlers.onArtifactsChanged).toHaveBeenLastCalledWith({ artifactId: '', kind: 'published' });
  });
});
