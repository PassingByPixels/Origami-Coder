// claudeCodeAdversarial.test.ts — the 0.4.73 UAT round, one describe per defect.
//
// Every case here stands over something a user SAW and no existing test could
// have caught, so each one names the observation it is the guard for. The
// fixtures are the same captured live frames the rest of the suite uses; where
// a shape had to be constructed (a multi-iteration turn, an account usage body)
// it is derived from a real one and says so.

import { beforeEach, describe, expect, it } from 'vitest';
import {
  HIDDEN_THINKING_NOTE, newTranslatorState, translate, type TranslatorState, type WebviewPost,
} from '../../../src/claudeCode/translator';
import { INTERRUPTED_TOOL_NOTE, UNRESOLVED_TOOL_NOTE, settleOpenTools } from '../../../src/claudeCode/cellState';
import { resultUsage } from '../../../src/claudeCode/turnUsage';
import { connectedLine, originClause } from '../../../src/claudeCode/sessionFacts';
import { adoptAccountPill } from '../../../src/claudeCode/sessionState';
import {
  USAGE_URL, USAGE_USER_AGENT, __resetPlanUsageForTests, planPillOf, readPlanUsage,
  type PlanUsageDeps,
} from '../../../src/claudeCode/planUsage';
import {
  __resetClaudeCodeForTests, handleClaudeCodeMessage, isEngineEchoOnBoundCell,
  type ClaudeCodeHost,
} from '../../../src/dashboard/claudeCodeManager';
import type { SpawnChild } from '../../../src/claudeCode/driver';
import { FakeChild } from './claudeCodeFakeChild';
import {
  RUN1_BLOCK_START_THINKING, RUN1_BLOCK_STOP_0, RUN1_RESULT, RUN1_SIGNATURE_DELTA,
  RUN1_STDOUT_LINES, RUN1_SYSTEM_INIT, RUN1_THINKING_DELTA_1, RUN2_ASSISTANT_TOOL_USE,
  RUN2_BLOCK_START_TOOL_USE, RUN2_USER_TOOL_RESULT,
} from './claudeCodeFixtures';

const ev = (line: string) => JSON.parse(line) as Record<string, unknown> & { type: string };
const run = (st: TranslatorState, ...lines: string[]): WebviewPost[] =>
  lines.flatMap((l) => translate(ev(l), st));
const typesOf = (posts: WebviewPost[]) => posts.map((p) => p.type);

// ─────────────────────────────────────────────────────────────────────────────
// DEFECT 3/4 — "the context meter looks cumulative across chats, and the turn
// counter reads 0". Two bugs with one shape: nothing counted turns, and the
// occupancy numerator was the SUM of every model call in the turn.
// ─────────────────────────────────────────────────────────────────────────────

/** RUN1_RESULT with a SECOND iteration spliced in — the shape a turn that ran a
 *  tool actually has. Built from the captured frame so the surrounding fields
 *  (modelUsage, contextWindow, stop_reason) stay real; only `usage` is edited,
 *  and edited the way the CLI does it: the top level is the SUM of the array. */
function twoIterationResult(): Record<string, unknown> {
  const frame = ev(RUN1_RESULT);
  const usage = frame.usage as Record<string, unknown>;
  const first = { input_tokens: 10, output_tokens: 62, cache_read_input_tokens: 0, cache_creation_input_tokens: 36352, type: 'message' };
  const second = { input_tokens: 8, output_tokens: 41, cache_read_input_tokens: 36400, cache_creation_input_tokens: 120, type: 'message' };
  frame.usage = {
    ...usage,
    input_tokens: first.input_tokens + second.input_tokens,
    output_tokens: first.output_tokens + second.output_tokens,
    cache_read_input_tokens: first.cache_read_input_tokens + second.cache_read_input_tokens,
    cache_creation_input_tokens: first.cache_creation_input_tokens + second.cache_creation_input_tokens,
    iterations: [first, second],
  };
  return frame;
}

describe('the context meter reads occupancy, not the turn total', () => {
  it('takes the LAST iteration of a multi-call turn, not the sum of them', () => {
    const usage = resultUsage(twoIterationResult() as never)!;

    // The last call had 8 fresh + 36,400 cache-read + 120 cache-write sitting in
    // the window. The SUM — what the meter used to read — is 72,990, which on a
    // 200k window is 36% for a two-call turn that occupied 18%.
    expect(usage.tokensUsed).toBe(8 + 36_400 + 120);
    expect(usage.tokensUsed).not.toBe(18 + 36_400 + 36_472);
    // The turn's own SIZE counts are unchanged — they are what the engine mirror
    // stores, and "what this turn cost" is a different question from "what is in
    // the window now".
    expect(usage.tokens).toEqual({ input: 18, output: 103, cacheRead: 36_400, cacheWrite: 36_472 });
  });

  it('falls back to the top-level fields when the CLI sends no iterations', () => {
    const frame = ev(RUN1_RESULT);
    delete (frame.usage as Record<string, unknown>).iterations;

    // A single-call turn: the sum and the last iteration are the same number, so
    // the fallback is exactly right rather than merely safe.
    expect(resultUsage(frame as never)!.tokensUsed).toBe(10 + 0 + 36_352);
  });

  it('counts this cell\'s completed turns onto contextUpdate', () => {
    const st = newTranslatorState('session-1');

    const first = run(st, RUN1_RESULT).find((p) => p.type === 'contextUpdate')!;
    const second = run(st, RUN1_RESULT).find((p) => p.type === 'contextUpdate')!;

    // 0.4.73 sent no `turns` at all, and the composer's counter is fed by an
    // engine-side poll a bound cell never runs — so it read "0 turns" for the
    // life of every passthrough chat.
    expect(first.turns).toBe(1);
    expect(second.turns).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// DEFECT 3 — the per-cell isolation audit. The resume-bug class: anything kept
// per MODULE instead of per CELL leaks between chats.
// ─────────────────────────────────────────────────────────────────────────────

describe('two cells, interleaved, share nothing', () => {
  it('keeps turns, occupancy, open cards, the connected line and the pill apart', () => {
    const a = newTranslatorState('session-1', { origin: originClause(false, 'C:\\a') });
    const b = newTranslatorState('session-2', { origin: originClause(true, 'C:\\b') });

    // Interleaved deliberately, and not in matching order: A opens a tool and
    // never resolves it while B runs two clean turns around it.
    run(a, RUN1_SYSTEM_INIT);
    run(b, RUN1_SYSTEM_INIT);
    run(a, RUN2_BLOCK_START_TOOL_USE, RUN2_ASSISTANT_TOOL_USE);
    run(b, RUN1_RESULT);
    run(b, RUN1_RESULT);
    const aPosts = run(a, RUN1_RESULT);

    expect(a.turns).toBe(1);
    expect(b.turns).toBe(2);
    // A's stray card was settled on A's turn close and never appeared on B.
    expect(a.openTools.size).toBe(0);
    expect(b.openTools.size).toBe(0);
    expect(aPosts.filter((p) => p.type === 'toolResult').map((p) => p.sessionId)).toEqual(['session-1']);
    // Every post either cell produced carries its OWN id, in both directions.
    expect(new Set(aPosts.map((p) => p.sessionId))).toEqual(new Set(['session-1']));
    expect(new Set(run(b, RUN1_RESULT).map((p) => p.sessionId))).toEqual(new Set(['session-2']));
    // The bind-time clause is a property of the BINDING, so the two lines differ
    // even though both cells saw the identical `system/init` frame.
    expect(String(a.lastConnected)).toContain('new session in C:\\a');
    expect(String(b.lastConnected)).toContain('resuming your last session in C:\\b');
    expect(a.lastConnected).not.toBe(b.lastConnected);

    // The SUB-AGENT HEARTBEAT is per-cell too, and it is the field most likely
    // to merge by accident: both cells spawn a Task, both Tasks are given the
    // SAME tool_use id (the id is unique per CLI session, not across them), and
    // the child frames that feed the tally are the ones the transcript drops —
    // so a shared bag would be counted, shown in both drawers, and seen by
    // nobody until a user asked why an idle chat had an agent out.
    const taskFrame = (description: string) => {
      const f = ev(RUN2_ASSISTANT_TOOL_USE);
      (f.message as Record<string, unknown>).content = [
        { type: 'tool_use', id: 'toolu_shared', name: 'Task', input: { description } },
      ];
      return JSON.stringify(f);
    };
    // A real captured frame with ONE field substituted, exactly as the
    // sub-agent drop tests derive theirs.
    const childFrame = RUN2_ASSISTANT_TOOL_USE.replace('"parent_tool_use_id":null', '"parent_tool_use_id":"toolu_shared"');
    run(a, taskFrame('A works'));
    run(b, taskFrame('B works'));
    const aBeat = run(a, childFrame);
    expect(a.agents.get('toolu_shared')).toMatchObject({ name: 'A works', tools: 1, msgs: 1 });
    expect(b.agents.get('toolu_shared')).toMatchObject({ name: 'B works', tools: 0, msgs: 0 });
    expect(new Set(aBeat.map((p) => p.sessionId))).toEqual(new Set(['session-1']));
    // A's turn ending clears A's tally and leaves B's agent out.
    run(a, RUN1_RESULT);
    expect(a.agents.size).toBe(0);
    expect(b.agents.size).toBe(1);

    // The badge, last: an account read adopted by A must not reach B.
    adoptAccountPill(a, { status: 'account', window: '5h', pct: 22, resetsAt: 1, title: 'A' });
    expect(a.pill?.pct).toBe(22);
    expect(b.pill).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// DEFECT 2 — the stuck card. A Read spun for the rest of the session.
// ─────────────────────────────────────────────────────────────────────────────

describe('a turn that ends settles every card it left open', () => {
  it('closes a card whose tool_result never arrived, on the turn-closing result', () => {
    const st = newTranslatorState('session-1');
    run(st, RUN2_BLOCK_START_TOOL_USE, RUN2_ASSISTANT_TOOL_USE);
    expect(st.openTools.size).toBe(1);

    const posts = run(st, RUN1_RESULT);

    // MUTATION PROOF: delete the `settleOpenTools` call in translator.fromResult
    // and this goes red — the settling toolResult disappears and the card is left
    // `in_progress` for ever, which is precisely the 0.4.73 screenshot.
    const settle = posts.find((p) => p.type === 'toolResult')!;
    expect(settle).toMatchObject({
      toolCallId: 'toolu_01Tam2qmJwK1fMj1GQHUYkSF',
      status: 'failed',
      content: UNRESOLVED_TOOL_NOTE,
      toolName: 'Write',
    });
    // It settles BEFORE the turn closes, so the mirrored copy of the turn
    // records the same outcome the transcript shows.
    expect(typesOf(posts).indexOf('toolResult')).toBeLessThan(typesOf(posts).indexOf('turnDone'));
    expect(st.openTools.size).toBe(0);
  });

  it('leaves a card that DID resolve alone', () => {
    const st = newTranslatorState('session-1');
    run(st, RUN2_BLOCK_START_TOOL_USE, RUN2_ASSISTANT_TOOL_USE, RUN2_USER_TOOL_RESULT);

    const posts = run(st, RUN1_RESULT);

    // No second, contradicting result for a card the CLI already completed.
    expect(posts.filter((p) => p.type === 'toolResult')).toEqual([]);
  });

  it('settles an open card when the child is interrupted, with the cause named', () => {
    const st = newTranslatorState('session-1');
    run(st, RUN2_BLOCK_START_TOOL_USE, RUN2_ASSISTANT_TOOL_USE);

    const posts = settleOpenTools(st, INTERRUPTED_TOOL_NOTE);

    expect(posts).toHaveLength(1);
    expect(posts[0]!.content).toBe(INTERRUPTED_TOOL_NOTE);
    // Draining is idempotent: a cancel followed by the child's exit must not
    // post two results for one card.
    expect(settleOpenTools(st, INTERRUPTED_TOOL_NOTE)).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// DEFECT 5 — the empty "Thought process" expando.
// ─────────────────────────────────────────────────────────────────────────────

describe('thinking is either shown or accounted for', () => {
  it('says so when a thinking block signs its reasoning without sharing it', () => {
    const st = newTranslatorState('session-1');

    // The captured order for a signature-only block: start (thinking: ""), the
    // signature delta, stop. Phase 1 opened a row on the empty start and never
    // put anything in it.
    const posts = run(st, RUN1_BLOCK_START_THINKING, RUN1_SIGNATURE_DELTA, RUN1_BLOCK_STOP_0);

    expect(posts).toEqual([{ type: 'agentThought', text: HIDDEN_THINKING_NOTE, sessionId: 'session-1' }]);
  });

  it('says nothing extra when the reasoning DID stream', () => {
    const st = newTranslatorState('session-1');

    const posts = run(st, RUN1_BLOCK_START_THINKING, RUN1_THINKING_DELTA_1, RUN1_SIGNATURE_DELTA, RUN1_BLOCK_STOP_0);

    expect(posts.map((p) => p.text)).toEqual(['The']);
  });

  it('does not open a row for an empty thinking delta', () => {
    const st = newTranslatorState('session-1');
    const empty = RUN1_THINKING_DELTA_1.replace('"thinking":"The"', '"thinking":""');

    expect(run(st, RUN1_BLOCK_START_THINKING, empty)).toEqual([]);
  });

  // THE END-TO-END CHECK for "thoughts do not render". Replaying the WHOLE
  // captured turn — every stdout line of spike/transcript_run1.txt, in order —
  // proves the reasoning text does leave the host as `agentThought` with a body,
  // which is the half a unit test on one delta cannot claim. The remaining risk
  // is named in the round's report: this transcript is haiku, and no capture of
  // a signature-only (summary-only) model exists to replay.
  it('carries real reasoning text out of a whole captured turn', () => {
    const st = newTranslatorState('session-1');

    const thoughts = RUN1_STDOUT_LINES.flatMap((l) => translate(ev(l), st)).filter((p) => p.type === 'agentThought');

    expect(thoughts.length).toBeGreaterThan(0);
    expect(thoughts.every((p) => String(p.text).length > 0)).toBe(true);
    expect(thoughts.map((p) => p.text).join('')).toContain('the single word PONG');
    // And no honest-fallback note, because this block DID share its reasoning.
    expect(thoughts.some((p) => p.text === HIDDEN_THINKING_NOTE)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// DEFECT 1 — three system rows above a new chat's first answer.
// ─────────────────────────────────────────────────────────────────────────────

describe('the connected line carries the binding', () => {
  const FACTS = {
    version: '2.1.198', model: 'claude-sonnet-5', apiKeySource: 'none', tools: 41,
    servers: 2, commands: ['a', 'b'], skills: [], memoryPaths: [],
  };

  it('names how the binding started, in the line that also names the facts', () => {
    const fresh = connectedLine(FACTS, true, originClause(false, 'C:\\repo'));
    const resumed = connectedLine(FACTS, true, originClause(true, 'C:\\repo'));

    expect(fresh).toContain('new session in C:\\repo');
    expect(resumed).toContain('resuming your last session in C:\\repo');
    // The counts the bind-time line could never have carried — it was written
    // before the child had said anything.
    expect(fresh).toContain('41 tools');
  });

  it('says nothing about the origin when there is no cwd to name', () => {
    expect(connectedLine(FACTS, true)).not.toContain('session in');
    expect(originClause(true, '')).toBe('');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// DEFECT 7 — the pill was invisible until the account was near a limit.
// ─────────────────────────────────────────────────────────────────────────────

/** The endpoint's REAL body, read off a live 200 from this machine's own
 *  account on 2026-08-31 (probe logged in the round's report). Trimmed to the
 *  lanes that carry a number plus one null lane and the `limits` array, so the
 *  parser is exercised against the shape it will actually meet. */
const USAGE_BODY = {
  five_hour: { utilization: 22, resets_at: '2026-08-31T19:49:59.878958+00:00', limit_dollars: null },
  seven_day: { utilization: 4, resets_at: '2026-09-07T16:59:59.878992+00:00', limit_dollars: null },
  seven_day_opus: null,
  nimbus_quill: { utilization: 0, resets_at: null },
  limits: [{ kind: 'session', percent: 22, severity: 'normal' }],
};

const TOKEN = 'sk-ant-oat01-NEVER-LOGGED';

function usageDeps(over: Partial<PlanUsageDeps> & { body?: unknown; ok?: boolean; expiresAt?: number } = {}) {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const logs: string[] = [];
  const deps: PlanUsageDeps = {
    homedir: () => 'C:\\Users\\test',
    readFile: () => JSON.stringify({
      claudeAiOauth: { accessToken: TOKEN, expiresAt: over.expiresAt ?? 2_000_000_000_000 },
    }),
    fetch: async (url, init) => {
      calls.push({ url, headers: init.headers });
      return { ok: over.ok !== false, status: over.ok === false ? 401 : 200, json: async () => over.body ?? USAGE_BODY };
    },
    now: () => 1_788_207_000_000,
    log: (l) => logs.push(l),
    ...over,
  };
  return { deps, calls, logs };
}

describe('the plan headroom pill, without waiting for a warning', () => {
  beforeEach(() => __resetPlanUsageForTests());

  it('reports the TIGHTEST lane, not the first one in the body', () => {
    const pill = planPillOf(USAGE_BODY, 1_788_207_000_000)!;

    // 22% of a five-hour session is what the account is actually about to hit;
    // 4% of the week is the reassuring number and the wrong one to show.
    expect(pill.pct).toBe(22);
    expect(pill.window).toBe('5h');
    expect(pill.resetsAt).toBe(Date.parse('2026-08-31T19:49:59.878958+00:00'));
    expect(pill.title).toContain('22% of your 5h limit used');
    expect(pill.title).toContain('no per-turn charge');
  });

  it('reads nothing usable out of a body it does not recognise', () => {
    expect(planPillOf({ five_hour: null, limits: [] }, 0)).toBeNull();
    expect(planPillOf('not json', 0)).toBeNull();
    expect(planPillOf(null, 0)).toBeNull();
  });

  it('carries every future-reset lane in `windows`, for the tooltip', () => {
    // `now` (1_788_207_000_000) sits AFTER the five-hour lane's own reset — the
    // same "now" the TIGHTEST-lane test above uses, so `windows` here proves
    // the filter independently of the pill's own pct/resetsAt picking `top`
    // from every lane regardless of whether its reset has passed. Only
    // `seven_day` still has a FUTURE reset at this instant.
    const pill = planPillOf(USAGE_BODY, 1_788_207_000_000)!;
    // `nimbus_quill` (0%, resets_at: null) is dropped for the same reason —
    // nothing to plot a countdown against, the rule planWindowsOf applies too.
    expect(pill.windows).toEqual([
      { label: '7d', pct: 4, resetsAt: Date.parse('2026-09-07T16:59:59.878992+00:00') },
    ]);
  });

  it('a monthly lane wins the pill percent when it is the tightest — 73% 5h next to 100% monthly reads 100%', () => {
    const now = 1_788_207_000_000;
    const body = {
      five_hour: { utilization: 73, resets_at: new Date(now + 3_600_000).toISOString() },
      thirty_day: { utilization: 100, resets_at: new Date(now + 20 * 86_400_000).toISOString() },
    };
    const pill = planPillOf(body, now)!;
    expect(pill.pct).toBe(100);
    expect(pill.window).toBe('30d');
    expect(pill.windows.map((w) => w.label)).toEqual(['5h', '30d']);
    expect(pill.windows.find((w) => w.label === '30d')?.pct).toBe(100);
  });

  it('sends the bearer and the CLI user agent, and NEVER exposes the token', async () => {
    const { deps, calls, logs } = usageDeps();

    const pill = await readPlanUsage(deps);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(USAGE_URL);
    expect(calls[0]!.headers['authorization']).toBe(`Bearer ${TOKEN}`);
    expect(calls[0]!.headers['user-agent']).toBe(USAGE_USER_AGENT);
    // THE LEAK ASSERTION. Everything that leaves this module — the pill that
    // crosses to the webview, and every log line — is searched for the token.
    // MUTATION PROOF: put the token in the pill title, or log it, and this reds.
    expect(JSON.stringify(pill)).not.toContain(TOKEN);
    expect(logs.join('\n')).not.toContain(TOKEN);
    expect(pill!.pct).toBe(22);
  });

  it('does not call at all with an expired credential, and says nothing about it', async () => {
    const { deps, calls } = usageDeps({ expiresAt: 1 });

    expect(await readPlanUsage(deps)).toBeNull();
    expect(calls).toEqual([]);
  });

  it('degrades to no pill on a refusal, naming only the status', async () => {
    const { deps, logs } = usageDeps({ ok: false });

    expect(await readPlanUsage(deps)).toBeNull();
    expect(logs.join('\n')).toContain('HTTP 401');
    expect(logs.join('\n')).not.toContain(TOKEN);
  });

  it('answers three lazy triggers in a row with ONE call', async () => {
    const { deps, calls } = usageDeps();

    await readPlanUsage(deps);
    await readPlanUsage(deps);
    await readPlanUsage(deps);

    // Bind, model-bar open and turn end can all land inside a second. The cache
    // is what makes "always visible" cost one request rather than three.
    expect(calls).toHaveLength(1);
  });

  it('never overrides a live rate_limit_event, which is this session\'s OWN reading', () => {
    const st = newTranslatorState('session-1');
    st.pill = { status: 'allowed_warning', window: '7d', pct: 99, resetsAt: 5, title: 'from the CLI' };
    st.pillSource = 'event';

    expect(adoptAccountPill(st, { status: 'account', window: '5h', pct: 22, resetsAt: 9, title: 'from the account' })).toEqual([]);
    expect(st.pill.pct).toBe(99);
  });

  it('fills an EMPTY badge, and a read that says nothing blanks nothing', () => {
    const st = newTranslatorState('session-1');

    const posts = adoptAccountPill(st, { status: 'account', window: '5h', pct: 22, resetsAt: 9, title: 't' });
    expect(posts.map((p) => p.type)).toEqual(['passthroughMeter']);
    expect(posts[0]).toMatchObject({ sessionId: 'session-1', pillPct: 22, pillWindow: '5h' });

    expect(adoptAccountPill(st, null)).toEqual([]);
    expect(st.pill!.pct).toBe(22);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// DEFECT 2 — the duplicate cards. The engine re-broadcasts a MIRRORED row into
// the very cell that mirrored it.
// ─────────────────────────────────────────────────────────────────────────────

describe('engine updates on a bound cell are echoes', () => {
  beforeEach(() => __resetClaudeCodeForTests());

  it('is true only while Claude is driving the cell, and false the moment it is not', async () => {
    const posts: Array<Record<string, unknown>> = [];
    const children: FakeChild[] = [];
    const spawn: SpawnChild = () => { const c = new FakeChild(); children.push(c); return c; };
    const host: ClaudeCodeHost = {
      post: (m) => posts.push(m),
      cwd: 'C:\\repo',
      read: () => undefined,
      write: () => {},
      log: () => {},
      createCell: async () => 'session-1',
      redispatch: () => {},
      cli: async () => ({ binary: 'C:\\claude.exe', version: '2.1.198', source: 'probe' }),
      spawn,
      // No `planUsage`: the read is opt-in precisely so a test cannot reach a
      // real credential file or a real socket (claudeCodePill.ts says why).
    };

    expect(isEngineEchoOnBoundCell('session-1')).toBe(false);
    await handleClaudeCodeMessage(host, { type: 'newClaudeCodeSession' });
    // MUTATION PROOF for the panel's three guards: make this return false and
    // every mirrored tool part draws a second card in the cell that mirrored it.
    expect(isEngineEchoOnBoundCell('session-1')).toBe(true);
    // An UNBOUND cell must stay readable from the engine store — that replay is
    // the only way a recalled passthrough chat shows its transcript.
    await handleClaudeCodeMessage(host, { type: 'setModel', sessionId: 'session-1', modelId: 'openrouter/anthropic/claude-3' });
    expect(isEngineEchoOnBoundCell('session-1')).toBe(false);
  });
});
