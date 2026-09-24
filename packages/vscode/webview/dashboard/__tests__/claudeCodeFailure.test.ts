// claudeCodeFailure.test.ts — t-d94nra. What a passthrough chat says when the child DIES, when the
// plan refuses the turn, and when an ask is retired by the child rather than answered by the user.
//
// THE REPORT THIS EXISTS FOR (work laptop, 0.4.134, one prompt, no interrupt): the first Read
// completed, and the Write card ended "Tool: Write (failed) — Interrupted before Claude Code
// reported this tool's result." Nothing the user did could produce that wording: `cancel` is the
// only user path to it. So the child had gone, and the crash was wearing the interrupt's words
// while saying nothing about the exit code, the stderr, or the 98%-spent plan window.
//
// WHERE THE SHAPES COME FROM. The exit and tool frames are captured CLI lines (claudeCodeFixtures).
// The `rate_limit_event` and the 429 `result` are NOT captured — running a refusal on purpose costs
// the owner's plan — so they are built from the INSTALLED CLI's own schema, read out of
// C:\Users\dev\.local\bin\claude.exe (2.1.198) this session:
//   rate_limit_info: { status: "allowed"|"allowed_warning"|"rejected", resetsAt?: number (SECONDS),
//                      rateLimitType?: "five_hour"|"seven_day"|…, utilization?: number }
//   result (success): … api_error_status: number|null …
//   control_cancel_request: { type, request_id }  "Cancels a currently open control request."
// One place each, so the day one is captured there is a single line to correct.

import { beforeEach, describe, expect, it } from 'vitest';
import { ClaudeCodeDriver, type SpawnChild } from '../../../src/claudeCode/driver';
import type { ClaudeEvent } from '../../../src/claudeCode/protocol';
import { CRASHED_TOOL_NOTE, INTERRUPTED_TOOL_NOTE, newTranslatorState, translate } from '../../../src/claudeCode/translator';
import { BYPASS_CLAMP_NOTE } from '../../../src/dashboard/claudeCodePermissions';
import {
  __resetClaudeCodeForTests, handleClaudeCodeMessage, type ClaudeCodeHost,
} from '../../../src/dashboard/claudeCodeManager';
import { RUN1_RESULT, RUN1_SYSTEM_INIT, RUN2_BLOCK_START_TOOL_USE } from './claudeCodeFixtures';
import { FakeChild, canUseTool } from './claudeCodeFakeChild';

const SESSION = 'c6bab4a9-9d8a-4bf1-855d-9d7e146f884a';
const RUN2_SESSION = '995a1315-ff9c-4258-8acf-0e46add36bc9';
const RESETS_AT_SECONDS = 1_790_000_000;

/** A `rate_limit_event`, in the CLI's own schema (see the header). */
function rateLimit(status: string, utilization: number): string {
  return JSON.stringify({
    type: 'rate_limit_event', session_id: RUN2_SESSION,
    rate_limit_info: { status, utilization, rateLimitType: 'seven_day', resetsAt: RESETS_AT_SECONDS },
  });
}

function driverHarness(opts: Partial<ConstructorParameters<typeof ClaudeCodeDriver>[0]> = {}) {
  const children: FakeChild[] = [];
  const spawns: Array<readonly string[]> = [];
  const spawn: SpawnChild = (_c, args) => { spawns.push(args); const c = new FakeChild(); children.push(c); return c; };
  const exits: Array<{ reason: string; expected: boolean; info?: unknown }> = [];
  const cancels: string[] = [];
  const driver = new ClaudeCodeDriver(
    { binary: 'C:\\claude.exe', cwd: 'C:\\repo', mode: 'supervised', idleParkMs: 0, env: { PATH: 'p' }, spawn, ...opts },
    {
      onEvent: () => {},
      onPermissionAsk: () => {},
      onPermissionCancel: (id) => cancels.push(id),
      onExit: (reason, expected, info) => exits.push({ reason, expected, ...(info ? { info } : {}) }),
      onLog: () => {},
    },
  );
  return { driver, spawns, cancels, exits, child: (i = -1) => children.at(i)!, children };
}

type Info = { recovery: string; code: number | null; stderr: readonly string[]; pendingAsks: readonly string[] };
const infoOf = (e: { info?: unknown }) => e.info as Info;

describe('a child that dies mid-turn is resumed ONCE, and says what happened either way', () => {
  it('respawns with --resume, re-sends the turn\'s own prompt, and does not report the turn closed', () => {
    const h = driverHarness();
    h.driver.prompt('write the file');
    h.child().say(`${RUN1_SYSTEM_INIT}\n`);
    h.child().err('FATAL: connection reset\n');
    h.child().emitExit(1, null);

    expect(infoOf(h.exits.at(-1)!).recovery).toBe('resumed');
    expect(infoOf(h.exits.at(-1)!).code).toBe(1);
    expect(infoOf(h.exits.at(-1)!).stderr).toEqual(['FATAL: connection reset']);
    // A SECOND child, resumed onto the same conversation, carrying the same prompt again.
    expect(h.spawns).toHaveLength(2);
    expect(h.spawns[1]).toEqual(expect.arrayContaining(['--resume', SESSION]));
    expect(h.child().frames().at(-1)).toMatchObject({ type: 'user', session_id: SESSION });
    expect(JSON.stringify(h.child().frames().at(-1))).toContain('write the file');
  });

  it('gives up after ONE resume rather than looping a crash into the user\'s plan', () => {
    const h = driverHarness();
    h.driver.prompt('go');
    h.child().say(`${RUN1_SYSTEM_INIT}\n`);
    h.child().emitExit(1, null);            // first death -> resumed
    h.child().emitExit(1, null);            // the resumed child dies too
    expect(infoOf(h.exits.at(-1)!).recovery).toBe('already-tried');
    expect(h.spawns).toHaveLength(2);
  });

  it('does not resume into a spent plan window', () => {
    const h = driverHarness();
    h.driver.prompt('go');
    h.child().say(`${RUN1_SYSTEM_INIT}\n${rateLimit('rejected', 1)}\n`);
    h.child().emitExit(1, null);
    expect(infoOf(h.exits.at(-1)!).recovery).toBe('plan-limit');
    expect(h.spawns).toHaveLength(1);
  });

  it('does not resume a child that never named a session', () => {
    const h = driverHarness();
    h.driver.prompt('go');
    h.child().emitExit(1, null);
    expect(infoOf(h.exits.at(-1)!).recovery).toBe('no-session');
    expect(h.spawns).toHaveLength(1);
  });

  it('carries the asks that died with it, and stays silent about an idle exit', () => {
    const h = driverHarness();
    h.driver.prompt('go');
    h.child().say(`${RUN1_SYSTEM_INIT}\n${canUseTool('req-1', 'Write', { file_path: 'a.txt' })}\n`);
    h.child().say(`${RUN1_RESULT}\n`);       // the turn CLOSED before the child went
    h.child().emitExit(0, null);
    expect(infoOf(h.exits.at(-1)!).recovery).toBe('idle');
    expect(infoOf(h.exits.at(-1)!).pendingAsks).toEqual(['req-1']);
  });
});

describe('an ask the CHILD retires is reported, never left on screen answering nobody', () => {
  it('hands the cancel to the UI and refuses a later answer for it', () => {
    const h = driverHarness();
    h.driver.prompt('go');
    h.child().say(`${canUseTool('req-9', 'Write', { file_path: 'a.txt' })}\n`);
    h.child().say(`${JSON.stringify({ type: 'control_cancel_request', request_id: 'req-9' })}\n`);
    expect(h.cancels).toEqual(['req-9']);
    // The round trip is over: answering now must not push an unsolicited frame at the child.
    expect(h.driver.answerPermission('req-9', true, {})).toBe(false);
  });

  it('ignores a cancel for an ask already answered — that is tidying, not news', () => {
    const h = driverHarness();
    h.driver.prompt('go');
    h.child().say(`${canUseTool('req-9', 'Write', {})}\n`);
    h.driver.answerPermission('req-9', true, {});
    h.child().say(`${JSON.stringify({ type: 'control_cancel_request', request_id: 'req-9' })}\n`);
    expect(h.cancels).toEqual([]);
  });
});

describe('a plan refusal is its own card, with the reset time on it', () => {
  it('turns a REJECTED rate_limit_event into an error row, not the warning line', () => {
    const st = newTranslatorState('s1');
    const warn = translate(JSON.parse(rateLimit('allowed_warning', 0.98)) as ClaudeEvent, st);
    expect(warn.map((p) => p.type)).toEqual(['passthroughMeter', 'system']);

    const refused = translate(JSON.parse(rateLimit('rejected', 1)) as ClaudeEvent, st);
    const card = refused.find((p) => p.type === 'error')!;
    expect(card).toBeTruthy();
    expect(String(card.message)).toContain('out of plan headroom');
    expect(String(card.message)).toContain(new Date(RESETS_AT_SECONDS * 1000).toLocaleString());
  });

  it('reads a 429 result as a refusal rather than a generic ended-the-turn error', () => {
    const st = newTranslatorState('s1');
    translate(JSON.parse(rateLimit('rejected', 1)) as ClaudeEvent, st);   // the only frame with a reset time
    const posts = translate({
      type: 'result', subtype: 'error_during_execution', is_error: true, api_error_status: 429,
      stop_reason: null, num_turns: 1, total_cost_usd: 0, usage: {}, modelUsage: {},
      errors: ['API Error: 429 rate_limit_error'], session_id: RUN2_SESSION,
    } as ClaudeEvent, st);
    const card = posts.find((p) => p.type === 'error')!;
    expect(String(card.message)).toContain("your plan's limit is spent");
    expect(String(card.message)).toContain(new Date(RESETS_AT_SECONDS * 1000).toLocaleString());
    expect(String(card.message)).toContain('429 rate_limit_error');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// THE OWNER'S CASE, AT THE REAL SEAM: the manager's handler, the real driver, a
// scripted child. A Write card is open when the child goes.
// ─────────────────────────────────────────────────────────────────────────────

const CELL = 'session-1';

function seam() {
  const posts: Array<Record<string, unknown>> = [];
  const children: FakeChild[] = [];
  const spawn: SpawnChild = () => { const c = new FakeChild(); children.push(c); return c; };
  const host: ClaudeCodeHost = {
    post: (m) => posts.push(m),
    cwd: 'C:\\repo',
    read: () => undefined,
    write: () => {},
    log: () => {},
    createCell: async () => CELL,
    redispatch: () => {},
    cli: async () => ({ binary: 'C:\\claude.exe', version: '2.1.198', source: 'probe' }),
    spawn,
  };
  return { host, posts, child: (i = -1) => children.at(i)!, children };
}

async function openWriteCard(s: ReturnType<typeof seam>) {
  await handleClaudeCodeMessage(s.host, { type: 'newClaudeCodeSession' });
  await handleClaudeCodeMessage(s.host, { type: 'send', text: 'write the file', sessionId: CELL });
  s.child().say(`${RUN2_BLOCK_START_TOOL_USE}\n`);
}

const rows = (s: ReturnType<typeof seam>, type: string) => s.posts.filter((p) => p.type === type);

beforeEach(() => __resetClaudeCodeForTests());

describe('the Write card the owner watched fail', () => {
  it('never claims an interrupt nobody made, and names the exit code and the stderr', async () => {
    const s = seam();
    await openWriteCard(s);
    s.child().err('Error: spawn ETIMEDOUT\n');
    s.child().emitExit(3, null);

    const settled = rows(s, 'toolResult').filter((p) => p.status === 'failed');
    expect(settled).toHaveLength(1);
    expect(settled[0]!.content).toBe(CRASHED_TOOL_NOTE);
    expect(settled[0]!.content).not.toBe(INTERRUPTED_TOOL_NOTE);
    const said = [...rows(s, 'system'), ...rows(s, 'error')].map((p) => String(p.text ?? p.message)).join(' | ');
    expect(said).toContain('exit code 3');
    expect(said).toContain('spawn ETIMEDOUT');
  });

  it('keeps the turn OPEN across an automatic resume, and says the work may already be done', async () => {
    const s = seam();
    await openWriteCard(s);
    s.child().emitExit(1, null);
    // Resumed: the turn is still running, so closing it here would strand the answer on its way.
    expect(rows(s, 'turnDone')).toEqual([]);
    expect(s.children).toHaveLength(2);
    expect(rows(s, 'system').some((p) => String(p.text).includes('re-sent'))).toBe(true);
  });

  it('closes the turn — and says why there was no resume — when the plan refused it', async () => {
    const s = seam();
    await openWriteCard(s);
    s.child().say(`${rateLimit('rejected', 1)}\n`);
    s.child().emitExit(1, null);
    expect(s.children).toHaveLength(1);
    expect(rows(s, 'turnDone')).toHaveLength(1);
    expect(rows(s, 'error').map((p) => String(p.message)).join(' | ')).toContain('Not resumed');
  });
});

describe('the bypass clamp explains itself once a chat, not once an ask', () => {
  it('says it on the first bypass request and stays quiet on every later one', async () => {
    const s = seam();
    await handleClaudeCodeMessage(s.host, { type: 'newClaudeCodeSession' });
    for (let i = 0; i < 3; i += 1) {
      await handleClaudeCodeMessage(s.host, { type: 'setApproveMode', mode: 'bypass', sessionId: CELL });
    }
    expect(s.posts.filter((p) => p.text === BYPASS_CLAMP_NOTE)).toHaveLength(1);
  });

  it('says nothing at all when bypass was never requested', async () => {
    const s = seam();
    await handleClaudeCodeMessage(s.host, { type: 'newClaudeCodeSession' });
    await handleClaudeCodeMessage(s.host, { type: 'setApproveMode', mode: 'acceptEdits', sessionId: CELL });
    await handleClaudeCodeMessage(s.host, { type: 'setApproveMode', mode: 'auto', sessionId: CELL });
    expect(s.posts.filter((p) => p.text === BYPASS_CLAMP_NOTE)).toEqual([]);
  });
});
