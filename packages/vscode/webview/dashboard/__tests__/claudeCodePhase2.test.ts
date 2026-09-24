// claudeCodePhase2.test.ts — the four things phase 2 added that a user can
// actually see: the plan round trip, attachments on the wire, a transcript that
// survives a reattach, and a Claude reviewer.
//
// These are SEAM tests, not unit tests, and deliberately so. Every one of them
// is a claim about a path that crosses three modules — webview message →
// claudeCodeManager → the cell/permissions/review leaf → the driver → stdin —
// and each of those hops is somewhere the message can be silently dropped. The
// phase 1 bug this file's plan tests exist for was exactly that shape: allowing
// a plan wrote a correct `control_response` to the child and then nothing
// flipped the mode, so the approved plan's first edit was refused by the CLI.
// A unit test of the allow builder would have passed all the way through it.
//
// FIXTURE PROVENANCE. The `can_use_tool` frame is DENY_CAN_USE_TOOL — a real
// line off spike/transcript_deny.txt (CLI 2.1.198). `ExitPlanMode` is that same
// captured frame with the tool name and input swapped, because no captured
// transcript contains a plan round trip: this machine's transcripts hold the
// name only inside `init.tools`. The FRAME is real; the plan's own fields are
// built to the documented contract, and that is stated at the test.

import { beforeEach, describe, expect, it } from 'vitest';
import {
  __resetClaudeCodeForTests, claudeCodeOwns, handleClaudeCodeMessage, type ClaudeCodeHost,
} from '../../../src/dashboard/claudeCodeManager';
import { KEEP_PLANNING_MESSAGE } from '../../../src/dashboard/claudeCodePermissions';
import { REVIEW_ATTRIBUTION, reviewDigest } from '../../../src/dashboard/claudeCodeReview';
import { PASSTHROUGH_LOG_CAP } from '../../../src/dashboard/claudeCodeLog';
import type { SessionMessage } from '../../../src/dashboard/sessionLog';
import type { SpawnChild } from '../../../src/claudeCode/driver';
import { isQuestionShaped } from '../components/permissionOptions';
import { applySecondOpinion } from '../panes/secondOpinion';
import { FakeChild } from './claudeCodeFakeChild';
import { DENY_CAN_USE_TOOL, RUN1_RESULT, RUN1_TEXT_DELTA } from './claudeCodeFixtures';

const CWD = 'C:\\repo';
const CELL = 'session-1';

interface Seam {
  host: ClaudeCodeHost;
  posts: Array<Record<string, unknown>>;
  logs: string[];
  /** The panel's per-session replay log — a real array, as DashboardPanel hands
   *  over (`this.sessions.get(sid)?.messageLog`). */
  replay: SessionMessage[];
  children: FakeChild[];
  child(): FakeChild;
  postsOf(type: string): Array<Record<string, unknown>>;
  /** Every frame written to the newest child's stdin, parsed. */
  written(): Array<Record<string, unknown>>;
  modelBroadcasts: number;
}

function seam(): Seam {
  const posts: Array<Record<string, unknown>> = [];
  const logs: string[] = [];
  const replay: SessionMessage[] = [];
  const children: FakeChild[] = [];
  const counters = { models: 0 };
  const spawn: SpawnChild = () => { const c = new FakeChild(); children.push(c); return c; };
  const host: ClaudeCodeHost = {
    post: (m) => posts.push(m),
    cwd: CWD,
    read: () => undefined,
    write: () => {},
    log: (l) => logs.push(l),
    createCell: async () => CELL,
    redispatch: () => {},
    refreshModels: () => { counters.models += 1; },
    replayLog: (sid) => (sid === CELL ? replay : undefined),
    cli: async () => ({ binary: 'C:\\claude.exe', version: '2.1.198', source: 'probe' }),
    spawn,
  };
  return {
    host, posts, logs, replay, children,
    child: () => children[children.length - 1]!,
    postsOf: (t) => posts.filter((p) => p.type === t),
    written: () => children[children.length - 1]!.frames(),
    get modelBroadcasts() { return counters.models; },
  };
}

const create = async (s: Seam) => handleClaudeCodeMessage(s.host, { type: 'newClaudeCodeSession' });
const send = (s: Seam, text = 'go') => handleClaudeCodeMessage(s.host, { type: 'send', text, sessionId: CELL });

/**
 * Start a review, wait for its child to be spawned, hand it `stdout`, and let
 * the handler finish.
 *
 * The handler AWAITS the whole review — the child has to answer before the
 * promise settles — so a test cannot await it first and drive the child after.
 * The poll is on the child EXISTING rather than on a fixed number of ticks:
 * `reviewWithClaude` awaits detection before it spawns, and counting microtasks
 * would make the test fragile against an extra `await` appearing upstream.
 */
async function review(s: Seam, model: string, stdout: string[]): Promise<void> {
  const before = s.children.length;
  const done = handleClaudeCodeMessage(s.host, { type: 'secondOpinion', sessionId: CELL, modelId: model, modelLabel: 'Opus' });
  for (let i = 0; i < 50 && s.children.length === before; i++) await Promise.resolve();
  if (s.children.length > before) for (const line of stdout) s.child().say(`${line}\n`);
  await done;
}

/** The captured `can_use_tool` frame, re-pointed at ExitPlanMode. The envelope
 *  (type, request_id, subtype, the `input` key) is verbatim from the wire. */
function exitPlanFrame(plan: string, requestId = 'req-plan-1'): string {
  const real = JSON.parse(DENY_CAN_USE_TOOL) as Record<string, unknown>;
  const req = real.request as Record<string, unknown>;
  return JSON.stringify({
    ...real, request_id: requestId,
    request: { ...req, tool_name: 'ExitPlanMode', display_name: 'ExitPlanMode', input: { plan } },
  });
}

beforeEach(() => __resetClaudeCodeForTests());

// ── A. the model label ───────────────────────────────────────────────────────
describe('the picked model shows immediately', () => {
  it('re-broadcasts the session models the moment a bind lands', async () => {
    const s = seam();
    expect(s.modelBroadcasts).toBe(0);
    await create(s);
    // The panel's own broadcast reads `claudeCodeModelOf` FIRST, and the cell is
    // in the map by the time this fires — so the label is the picked model in
    // the same tick as the pick, with no optimistic value to reconcile later.
    // Without it the picker kept the PREVIOUS model's name until the child's
    // first event, which on a cell nobody has typed into is never.
    expect(s.modelBroadcasts).toBeGreaterThan(0);
  });

  it('re-broadcasts again when an engine model takes the cell back', async () => {
    const s = seam();
    await create(s);
    const afterBind = s.modelBroadcasts;
    await handleClaudeCodeMessage(s.host, { type: 'setModel', modelId: 'lmstudio/qwen3-30b', sessionId: CELL });
    expect(s.modelBroadcasts).toBeGreaterThan(afterBind);
  });
});

// ── H. polish: the chat names itself ─────────────────────────────────────────
describe('a passthrough chat names itself after its first line', () => {
  it('replaces the shared placeholder, once', async () => {
    const s = seam();
    await create(s);
    // Every passthrough chat opened from the pill was titled "Claude Code", so
    // four of them in the sidebar were four identical rows.
    expect(s.postsOf('sessionTitle').at(-1)).toMatchObject({ title: 'Claude Code' });
    await send(s, 'fix the parser crash on empty input');
    expect(s.postsOf('sessionTitle').at(-1)).toMatchObject({ title: 'Fix The Parser Crash' });
    await send(s, 'now do something else entirely');
    // A second message must not rename a chat the user has been reading.
    expect(s.postsOf('sessionTitle').at(-1)).toMatchObject({ title: 'Fix The Parser Crash' });
  });
});

// ── C. plan mode, and the plan card ──────────────────────────────────────────
describe('the Plan button drives CLAUDE, not the engine', () => {
  it('claims setMode for a bound cell instead of letting it reach the engine', async () => {
    const s = seam();
    await create(s);
    expect(claudeCodeOwns({ type: 'setMode', sessionId: CELL })).toBe(true);
  });

  it('respawns with --permission-mode plan', async () => {
    const s = seam();
    await create(s);
    await send(s);
    await handleClaudeCodeMessage(s.host, { type: 'setMode', modeId: 'plan', sessionId: CELL });
    // The CLI reads --permission-mode at SPAWN, so the change is only visible on
    // the NEXT child. That is why the mode flip parks and the next prompt
    // respawns; asserting on the current child would prove nothing.
    await send(s, 'plan it');
    const spawnLog = s.logs.filter((l) => l.includes('spawned')).at(-1)!;
    expect(spawnLog).toContain('"--permission-mode","plan"');
    expect(spawnLog).not.toContain('bypass');
  });

  it('treats deep-plan as planning rather than refusing it', async () => {
    const s = seam();
    await create(s);
    await handleClaudeCodeMessage(s.host, { type: 'setMode', modeId: 'deep-plan', sessionId: CELL });
    await send(s);
    expect(s.logs.filter((l) => l.includes('spawned')).at(-1)!).toContain('"--permission-mode","plan"');
  });

  it('draws a plan CARD, not a tool-approval bar', async () => {
    const s = seam();
    await create(s);
    await send(s);
    s.child().say(`${exitPlanFrame('1. Read the file\n2. Fix the bug')}\n`);
    const ask = s.postsOf('requestPermission').at(-1)!;
    const options = ask.options as Array<{ optionId: string; name: string; kind: string }>;
    // isQuestionShaped picks the plan MODAL over the permission bar by the
    // ABSENCE of allow_always — the same discriminator the engine's own
    // plan_exit relies on. An allow_always here would both draw the wrong
    // surface and offer "approve every future plan unread".
    expect(isQuestionShaped(options)).toBe(true);
    expect(options.map((o) => o.name)).toEqual(['Approve & build', 'Keep planning']);
    // The plan itself goes in the SCROLLBACK, where it survives the decision.
    expect(s.postsOf('agentText').map((p) => p.text).join('')).toContain('2. Fix the bug');
  });

  it('APPROVE writes the allow AND flips the mode back', async () => {
    const s = seam();
    await create(s);
    // On auto-approve BEFORE planning, so the restore has something to get
    // wrong: a hardcoded 'supervised' would silently narrow it.
    await handleClaudeCodeMessage(s.host, { type: 'setApproveMode', mode: 'auto', sessionId: CELL });
    await send(s);
    await handleClaudeCodeMessage(s.host, { type: 'setMode', modeId: 'plan', sessionId: CELL });
    await send(s, 'plan it');
    s.child().say(`${exitPlanFrame('do the thing')}\n`);
    await handleClaudeCodeMessage(s.host, { type: 'permission', toolCallId: 'req-plan-1', optionId: 'approve_plan', sessionId: CELL });

    const allow = s.written().find((f) => f.type === 'control_response'
      && ((f.response as Record<string, unknown>).response as Record<string, unknown>)?.behavior === 'allow');
    expect(allow, 'the child must be unblocked with an allow').toBeTruthy();
    expect((allow!.response as Record<string, unknown>).request_id).toBe('req-plan-1');
    // THE PHASE 1 BUG. Allowing alone left the driver in plan mode, so the very
    // first edit of the approved plan was refused by the child itself. The next
    // spawn must be back on the pre-plan mode.
    await send(s, 'go build it');
    expect(s.logs.filter((l) => l.includes('spawned')).at(-1)!).toContain('"--permission-mode","acceptEdits"');
    expect(s.postsOf('modeUpdate').at(-1)).toMatchObject({ mode: 'build' });
  });

  it('KEEP PLANNING denies with a message that keeps Claude planning', async () => {
    const s = seam();
    await create(s);
    await send(s);
    await handleClaudeCodeMessage(s.host, { type: 'setMode', modeId: 'plan', sessionId: CELL });
    await send(s, 'plan it');
    s.child().say(`${exitPlanFrame('do the thing')}\n`);
    await handleClaudeCodeMessage(s.host, { type: 'permission', toolCallId: 'req-plan-1', optionId: 'keep_planning', sessionId: CELL });

    const deny = s.written().map((f) => (f.response as Record<string, unknown>)?.response as Record<string, unknown>)
      .find((r) => r?.behavior === 'deny');
    expect(deny?.message).toBe(KEEP_PLANNING_MESSAGE);
    // Still planning: nothing flipped the mode, so the next spawn stays in plan.
    await send(s, 'try again');
    expect(s.logs.filter((l) => l.includes('spawned')).at(-1)!).toContain('"--permission-mode","plan"');
  });

  it('reads a dismissed plan card as keep-planning, never as approval', async () => {
    const s = seam();
    await create(s);
    await send(s);
    s.child().say(`${exitPlanFrame('do the thing')}\n`);
    // optionId absent = the modal was cancelled. The child is BLOCKED on this
    // answer, so a silent drop hangs the session for good.
    await handleClaudeCodeMessage(s.host, { type: 'permission', toolCallId: 'req-plan-1', sessionId: CELL });
    const deny = s.written().map((f) => (f.response as Record<string, unknown>)?.response as Record<string, unknown>)
      .find((r) => r?.behavior === 'deny');
    expect(deny?.message).toBe(KEEP_PLANNING_MESSAGE);
  });

  it('still draws the ordinary bar for a real tool ask', async () => {
    const s = seam();
    await create(s);
    await send(s);
    s.child().say(`${DENY_CAN_USE_TOOL}\n`);
    const ask = s.postsOf('requestPermission').at(-1)!;
    expect(isQuestionShaped(ask.options as Array<{ kind: string }>)).toBe(false);
    expect((ask.options as Array<{ name: string }>).map((o) => o.name)).toContain('Always allow this tool');
  });
});

// ── D. attachments ───────────────────────────────────────────────────────────
describe('images ride the user turn', () => {
  const PNG = 'data:image/png;base64,iVBORw0KGgo=';

  it('claims sendWithImages for a bound cell', async () => {
    const s = seam();
    await create(s);
    // Before phase 2 this fell through to the panel and was prompted against
    // the ENGINE session under the cell: the CLI never saw the attachment.
    expect(claudeCodeOwns({ type: 'sendWithImages', sessionId: CELL })).toBe(true);
  });

  it('emits the documented content-block shape', async () => {
    const s = seam();
    await create(s);
    await handleClaudeCodeMessage(s.host, {
      type: 'sendWithImages', text: 'what is wrong here?', sessionId: CELL,
      images: [{ dataUrl: PNG, name: 'shot.png' }],
    });
    const turn = s.written().find((f) => f.type === 'user')!;
    const content = (turn.message as { content: Array<Record<string, unknown>> }).content;
    expect(content).toEqual([
      { type: 'text', text: 'what is wrong here?' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } },
    ]);
  });

  it('drops a media type the contract does not allow, and still sends the line', async () => {
    const s = seam();
    await create(s);
    await handleClaudeCodeMessage(s.host, {
      type: 'sendWithImages', text: 'look', sessionId: CELL,
      images: [{ dataUrl: 'data:image/bmp;base64,QQ==', name: 'x.bmp' }, { dataUrl: PNG, name: 'ok.png' }],
    });
    const content = (s.written().find((f) => f.type === 'user')!.message as { content: unknown[] }).content;
    // A dropped attachment is recoverable; a whole turn the child rejects is not.
    expect(content).toHaveLength(2);
  });

  it('leaves a plain text turn byte-identical to phase 1', async () => {
    const s = seam();
    await create(s);
    await send(s, 'hello');
    const turn = s.written().find((f) => f.type === 'user')!;
    expect(turn.message).toEqual({ role: 'user', content: [{ type: 'text', text: 'hello' }] });
  });
});

// ── E. the transcript survives ───────────────────────────────────────────────
describe('a passthrough transcript survives a tab reattach', () => {
  it('writes both halves of the conversation into the panel\'s replay log', async () => {
    const s = seam();
    await create(s);
    await send(s, 'say pong');
    s.child().say(`${RUN1_TEXT_DELTA}\n`);
    s.child().say(`${RUN1_RESULT}\n`);
    // `replaySessionsTo` catches a freshly attached webview up from THIS array
    // and nothing else, so anything missing here is gone on reattach. Phase 1
    // wrote nothing to it at all: every Claude turn was live-DOM only.
    const kinds = s.replay.map((e) => e.kind);
    expect(kinds).toContain('user');
    expect(kinds).toContain('agent');
    expect(s.replay.find((e) => e.kind === 'user')!.text).toBe('say pong');
    expect(s.replay.find((e) => e.kind === 'agent')!.text).toBe('PONG');
  });

  it('joins streamed deltas into one paragraph rather than a row each', async () => {
    const s = seam();
    await create(s);
    await send(s);
    for (const word of ['Hello', ' ', 'world']) {
      s.child().say(`${JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: word } }, session_id: 'x', parent_tool_use_id: null })}\n`);
    }
    const agents = s.replay.filter((e) => e.kind === 'agent');
    expect(agents).toHaveLength(1);
    expect(agents[0]!.text).toBe('Hello world');
  });

  it('restores a tool CARD, not a text row', async () => {
    const s = seam();
    await create(s);
    await send(s);
    s.child().say(`${JSON.stringify({ type: 'stream_event', event: { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_1', name: 'Read' } }, session_id: 'x', parent_tool_use_id: null })}\n`);
    s.child().say(`${JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'file contents' }] }, session_id: 'x', parent_tool_use_id: null })}\n`);
    const tool = s.replay.find((e) => e.kind === 'tool')!;
    // restoreLog replays `tool.call` / `tool.result` through the LIVE card rules
    // (chatToolMsg.ts), so both halves have to be there — a call with no result
    // restores as a card stuck in progress forever.
    expect(tool.tool?.call.toolCallId).toBe('toolu_1');
    expect(tool.tool?.result?.content).toBe('file contents');
  });

  it('caps the log so a long-running chat cannot grow without bound', async () => {
    const s = seam();
    await create(s);
    await send(s);
    // A passthrough child compacts on its own schedule and can run for hours,
    // so unlike an engine session nothing else bounds this array.
    for (let i = 0; i < PASSTHROUGH_LOG_CAP + 50; i++) {
      s.child().say(`${JSON.stringify({ type: 'system', subtype: 'init', session_id: 'x', model: `m${i}`, apiKeySource: 'none' })}\n`);
    }
    expect(s.replay.length).toBeLessThanOrEqual(PASSTHROUGH_LOG_CAP);
  });
});

// ── F. the Claude reviewer ───────────────────────────────────────────────────
describe('a second opinion from Claude Code', () => {
  it('claims a claude-code reviewer on an ORDINARY engine chat', () => {
    // The chat under review is an engine one, so no cell is bound — the routing
    // has to be on the model id. Without it the pick reached secondOpinion.ts,
    // which asked the engine for a `claude-code` provider that does not exist.
    expect(claudeCodeOwns({ type: 'secondOpinion', sessionId: 'session-9', modelId: 'claude-code/opus' })).toBe(true);
    expect(claudeCodeOwns({ type: 'secondOpinion', sessionId: 'session-9', modelId: 'openai/gpt-5' })).toBe(false);
  });

  it('spawns an ISOLATED child — no MCP, no hooks, no session written', async () => {
    const s = seam();
    s.replay.push({ kind: 'user', text: 'refactor the parser', timestamp: 1 });
    s.replay.push({ kind: 'agent', text: 'Done — I rewrote tokenize().', timestamp: 2 });
    await review(s, 'claude-code/opus', [RUN1_TEXT_DELTA, RUN1_RESULT]);
    const spawnLog = s.logs.filter((l) => l.includes('spawned')).at(-1)!;
    // The vector is logged as JSON, so each flag is quoted — asserting on the
    // raw substring would pass on a flag that merely appeared inside a path.
    for (const flag of ['"--no-session-persistence"', '"--strict-mcp-config"', '"--mcp-config"', 'mcpServers', 'disableAllHooks', '"--max-turns","1"', '"--model","opus"']) {
      expect(spawnLog, `missing ${flag}`).toContain(flag);
    }
    expect(spawnLog).not.toContain('bypass');
  });

  it('answers into the same card the engine reviewers use', async () => {
    const s = seam();
    s.replay.push({ kind: 'user', text: 'refactor the parser', timestamp: 1 });
    await review(s, 'claude-code/opus', [RUN1_TEXT_DELTA, RUN1_RESULT]);
    const results = s.postsOf('secondOpinionResult');
    // pending FIRST, then the answer, correlated by one id — secondOpinion.ts's
    // own protocol. The webview matches on the id and would drop an answer that
    // did not carry the pending card's.
    expect(results[0]).toMatchObject({ state: 'pending', modelLabel: 'Opus', attribution: REVIEW_ATTRIBUTION });
    expect(results.at(-1)).toMatchObject({ state: 'ok', text: 'PONG' });
    expect(results.at(-1)!.id).toBe(results[0]!.id);
    // The digest is built from the visible transcript, so it carries no file
    // diffs. Claiming otherwise would present a reviewer that could not see the
    // change as one that read it.
    expect(REVIEW_ATTRIBUTION).toContain('no file diffs');
  });

  it('denies every tool the reviewer asks for', async () => {
    const s = seam();
    s.replay.push({ kind: 'user', text: 'refactor the parser', timestamp: 1 });
    await review(s, 'claude-code/opus', [DENY_CAN_USE_TOOL, RUN1_TEXT_DELTA, RUN1_RESULT]);
    const answer = s.children.at(-1)!.frames()
      .map((f) => (f.response as Record<string, unknown>)?.response as Record<string, unknown>)
      .find((r) => r?.behavior === 'deny');
    // --max-turns 1 bounds the run, but a reviewer BLOCKED on a permission bar
    // nobody can see would sit there until the timeout instead of answering.
    expect(answer?.behavior).toBe('deny');
    expect(String(answer?.message)).toContain('Tools are disabled');
  });

  it('gives up rather than spinning forever on a child that never answers', async () => {
    const s = seam();
    s.replay.push({ kind: 'user', text: 'refactor the parser', timestamp: 1 });
    const host: ClaudeCodeHost = { ...s.host, timeoutMs: 5 };
    await handleClaudeCodeMessage(host, { type: 'secondOpinion', sessionId: CELL, modelId: 'claude-code/opus', modelLabel: 'Opus' });
    // The card has a spinner and no cancel, and the child is off screen — so a
    // silent `claude` used to mean a permanent spinner AND an orphaned process.
    expect(s.postsOf('secondOpinionResult').at(-1)).toMatchObject({ state: 'error' });
    expect(String(s.postsOf('secondOpinionResult').at(-1)!.error)).toContain('did not answer in time');
    expect(s.children.at(-1)!.killed).toBeGreaterThan(0);
  });

  it('refuses rather than reviewing an empty transcript', async () => {
    const s = seam();
    await handleClaudeCodeMessage(s.host, { type: 'secondOpinion', sessionId: CELL, modelId: 'claude-code/opus' });
    expect(s.postsOf('secondOpinionResult').at(-1)).toMatchObject({ state: 'error' });
    expect(s.children).toHaveLength(0); // nothing was spawned to answer nothing
  });
});

describe('the review card says what the review could not see', () => {
  it('carries the attribution all the way onto the message', () => {
    // The host posting `attribution` is not enough on its own: `info()` in
    // panes/secondOpinion.ts REBUILDS the card's payload field by field, so an
    // unlisted field is dropped in silence. This drives that projection with
    // the host's own wire shape, which is the hop the caveat was lost on.
    const opened: Array<Record<string, unknown>> = [];
    applySecondOpinion([], { id: 'so-1', modelId: 'claude-code/opus', modelLabel: 'Opus', state: 'pending', attribution: REVIEW_ATTRIBUTION },
      (_label, extra) => opened.push(extra as Record<string, unknown>));
    expect((opened[0]!.secondOpinion as { attribution?: string }).attribution).toBe(REVIEW_ATTRIBUTION);
  });

  it('keeps the caveat on the finished review, not just the spinner', () => {
    const opened: Array<Record<string, unknown>> = [];
    applySecondOpinion([], { id: 'so-1', modelId: 'claude-code/opus', modelLabel: 'Opus', state: 'pending', attribution: REVIEW_ATTRIBUTION },
      (_label, extra) => opened.push(extra as Record<string, unknown>));
    const card = { id: 1, kind: 'secondOpinion', label: 'x', text: '', ...(opened[0] as object) } as never;
    const next = applySecondOpinion([card], { id: 'so-1', state: 'ok', text: 'looks fine', attribution: REVIEW_ATTRIBUTION }, () => {})!;
    // The answer is the thing a reader weighs, so the caveat has to outlive the
    // spinner it first appeared under.
    expect((next[0] as { secondOpinion: { attribution?: string } }).secondOpinion.attribution).toBe(REVIEW_ATTRIBUTION);
  });

  it('leaves an ENGINE review card exactly as it was', () => {
    const opened: Array<Record<string, unknown>> = [];
    applySecondOpinion([], { id: 'so-2', modelId: 'openai/gpt-5', modelLabel: 'GPT-5', state: 'pending' },
      (_label, extra) => opened.push(extra as Record<string, unknown>));
    // An engine reviewer reads a digest with real diffs and has nothing to
    // disclaim — its card must keep the wording it has always had.
    expect((opened[0]!.secondOpinion as { attribution?: string }).attribution).toBeUndefined();
  });
});

describe('the review digest', () => {
  const entry = (kind: SessionMessage['kind'], text: string, at: number): SessionMessage => ({ kind, text, timestamp: at });

  it('keeps the END of the conversation when it cannot keep all of it', () => {
    const log: SessionMessage[] = [];
    for (let i = 0; i < 400; i++) log.push(entry('agent', `${'x'.repeat(400)} turn${i}`, i));
    const digest = reviewDigest(log);
    // The work being reviewed is the work that just happened, so the budget must
    // be spent on the recent half — not exhausted somewhere in the first hour.
    expect(digest).toContain('turn399');
    expect(digest).not.toContain('turn0 ');
  });

  it('leaves our own connection notices out of the reviewed conversation', () => {
    const digest = reviewDigest([
      entry('system', 'Claude Code 2.1.198 connected', 1),
      entry('user', 'is this right?', 2),
    ]);
    expect(digest).not.toContain('connected');
    expect(digest).toContain('User: is this right?');
  });

  it('tells the reviewer plainly that it cannot see the diffs', () => {
    const digest = reviewDigest([entry('user', 'review my change', 1)]);
    // A reviewer that does not know what it is missing invents confidence about
    // code it never read.
    expect(digest).toContain('NOT the file diffs');
    expect(digest).toContain('Use no tools');
  });
});
