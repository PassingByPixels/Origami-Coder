// claudeCodeMirror.test.ts — the three UAT defects of the 0.4.71 passthrough,
// each asserted on the seam a user would notice it on.
//
//   1. THE MIRROR. A passthrough chat binds a real engine session and never
//      wrote to it, so History, the Labyrinth and the usage tables — every
//      surface that reads ENGINE truth — showed an empty chat. A finished turn
//      is now copied over `session_append_foreign`.
//   2. THE TITLE. Phase 2's auto-title posted `sessionTitle` to the LIVE
//      webview only. That reaches the DOM and nothing else: `Session.title` on
//      the host stays unset (so the sidebar's own `sessionList` reply rebuilds
//      the row as "Tsuru #N"), and the ENGINE title stays the "New session -
//      <ISO>" placeholder that historyRows.isTurnless drops. It now goes
//      through `renameSession`, the panel's own authoritative rename.
//   3. THE CONNECTED LINE. The child is parked after five idle minutes and
//      respawned by the next prompt, and each spawn writes a fresh
//      `system/init` — so the "Claude Code 2.1.198 connected · …" paragraph
//      repeated every turn. It is emitted once per bind now, and again only if
//      it would say something different.
//
// SEAM TESTS, deliberately: every claim here crosses webview message →
// claudeCodeManager → the cell → `emit` → the mirror/the engine client, and
// each hop is somewhere the message can be silently dropped. FIXTURE
// PROVENANCE is claudeCodeFixtures.ts's own — real CLI 2.1.198 stdout.

import { beforeEach, describe, expect, it } from 'vitest';
import {
  __resetClaudeCodeForTests, handleClaudeCodeMessage, type ClaudeCodeHost,
} from '../../../src/dashboard/claudeCodeManager';
import { MIRROR_METHOD } from '../../../src/dashboard/claudeCodeMirror';
import type { SessionMessage } from '../../../src/dashboard/sessionLog';
import type { SpawnChild } from '../../../src/claudeCode/driver';
import { FakeChild } from './claudeCodeFakeChild';
import {
  RUN1_RESULT, RUN1_SYSTEM_INIT, RUN1_TEXT_DELTA,
  RUN2_ASSISTANT_TOOL_USE, RUN2_BLOCK_START_TOOL_USE, RUN2_USER_TOOL_RESULT,
} from './claudeCodeFixtures';

const CWD = 'C:\\repo';
const CELL = 'session-1';
const ENGINE_SESSION = 'ses_engine_1';

interface ExtCall {
  method: string;
  params?: Record<string, unknown>;
}

interface Seam {
  host: ClaudeCodeHost;
  posts: Array<Record<string, unknown>>;
  logs: string[];
  redispatched: Array<Record<string, unknown>>;
  ext: ExtCall[];
  children: FakeChild[];
  child(): FakeChild;
  postsOf(type: string): Array<Record<string, unknown>>;
}

function seam(over: { engineSessionId?: string | null; extFails?: boolean; noEngine?: boolean } = {}): Seam {
  const posts: Array<Record<string, unknown>> = [];
  const logs: string[] = [];
  const redispatched: Array<Record<string, unknown>> = [];
  const ext: ExtCall[] = [];
  const replay: SessionMessage[] = [];
  const children: FakeChild[] = [];
  const spawn: SpawnChild = () => { const c = new FakeChild(); children.push(c); return c; };
  const client = {
    currentSessionId: over.engineSessionId === undefined ? ENGINE_SESSION : over.engineSessionId,
    extMethod: async (method: string, params?: Record<string, unknown>) => {
      ext.push({ method, ...(params ? { params } : {}) });
      if (over.extFails) throw new Error('engine is busy');
      return {};
    },
  };
  const host: ClaudeCodeHost = {
    post: (m) => posts.push(m),
    cwd: CWD,
    read: () => undefined,
    write: () => {},
    log: (l) => logs.push(l),
    createCell: async () => CELL,
    redispatch: (m) => { redispatched.push(m); },
    replayLog: (sid) => (sid === CELL ? replay : undefined),
    ...(over.noEngine ? {} : { engine: (sid: string) => (sid === CELL ? { client, cwd: CWD } : undefined) }),
    cli: async () => ({ binary: 'C:\\claude.exe', version: '2.1.198', source: 'probe' }),
    spawn,
  };
  return {
    host, posts, logs, redispatched, ext, children,
    child: () => children[children.length - 1]!,
    postsOf: (t) => posts.filter((p) => p.type === t),
  };
}

/** Let the mirror's fire-and-forget flush settle. */
const settle = () => new Promise((r) => setTimeout(r, 0));

async function bind(s: Seam): Promise<void> {
  await handleClaudeCodeMessage(s.host, { type: 'newClaudeCodeSession' });
}

async function send(s: Seam, text: string): Promise<void> {
  await handleClaudeCodeMessage(s.host, { type: 'send', sessionId: CELL, text });
}

function say(s: Seam, ...lines: string[]): void {
  for (const line of lines) s.child().say(`${line}\n`);
}

beforeEach(() => { __resetClaudeCodeForTests(); });

describe('the mirror — a finished passthrough turn reaches the ENGINE session', () => {
  it('copies the turn in one call, naming the ENGINE session id and its cwd', async () => {
    const s = seam();
    await bind(s);
    await send(s, 'fix the parser');
    say(s, RUN1_SYSTEM_INIT, RUN1_TEXT_DELTA, RUN1_RESULT);
    await settle();

    expect(s.ext).toHaveLength(1);
    const call = s.ext[0]!;
    expect(call.method).toBe(MIRROR_METHOD);
    // Not the PANEL's `session-1` — the engine's own id, which is what the
    // engine store, History and the Labyrinth all key on.
    expect(call.params?.sessionId).toBe(ENGINE_SESSION);
    expect(call.params?.source).toBe('claude-code');
    expect(call.params?.cwd).toBe(CWD);
    const messages = call.params?.messages as Array<Record<string, unknown>>;
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(messages[0]!.text).toBe('fix the parser');
    expect(messages[1]!.text).toBe('PONG');
  });

  it('carries the turn TOOL CALLS, so the mirrored run is not just prose', async () => {
    const s = seam();
    await bind(s);
    await send(s, 'write a file');
    say(s, RUN1_SYSTEM_INIT, RUN2_BLOCK_START_TOOL_USE, RUN2_ASSISTANT_TOOL_USE, RUN2_USER_TOOL_RESULT, RUN1_RESULT);
    await settle();

    const messages = s.ext[0]!.params?.messages as Array<Record<string, unknown>>;
    const calls = messages[1]!.toolCalls as Array<Record<string, unknown>>;
    expect(calls.length).toBeGreaterThan(0);
    expect(typeof calls[0]!.name).toBe('string');
    expect((calls[0]!.name as string).length).toBeGreaterThan(0);
  });

  // TOKENS ARE A SIZE, NOT A PRICE. The mirror used to send no counts and the
  // engine stored zeros, so every passthrough turn read as a turn of no size in
  // the Labyrinth (which takes its tokens from `info.tokens` via run-steps.ts).
  // The counts below are the CLI's own, off the captured `result` line.
  it('carries the CLI\'s REAL token counts on the assistant row', async () => {
    const s = seam();
    await bind(s);
    await send(s, 'go');
    say(s, RUN1_SYSTEM_INIT, RUN1_TEXT_DELTA, RUN1_RESULT);
    await settle();

    const messages = s.ext[0]!.params?.messages as Array<Record<string, unknown>>;
    // RUN1_RESULT.usage: input 10, output 62, cache_read 0, cache_creation 36352.
    expect(messages[1]!.tokens).toEqual({ input: 10, output: 62, cacheRead: 0, cacheWrite: 36352 });
    // The user row is not a measurement of anything and carries none.
    expect(messages[0]!.tokens).toBeUndefined();
    // THE OTHER HALF OF THE RULE. Nothing on this batch may look like spend:
    // the engine prices a row from `cost` and from a `step-finish` part, and the
    // mirror is not entitled to send either. A turn on the user's subscription
    // is not this engine's bill.
    for (const message of messages) {
      expect(message.cost).toBeUndefined();
      expect(message.parts).toBeUndefined();
    }
  });

  it('sends no counts for a turn the CLI never reported one for', async () => {
    const s = seam();
    await bind(s);
    await send(s, 'go');
    say(s, RUN1_SYSTEM_INIT, RUN1_TEXT_DELTA);
    // Cancelled: no `result`, so no measurement exists. Zeros here would be a
    // claim, and the engine's own fallback is what fills the row instead.
    await handleClaudeCodeMessage(s.host, { type: 'cancel', sessionId: CELL });
    await settle();

    const messages = s.ext[0]!.params?.messages as Array<Record<string, unknown>>;
    expect(messages[1]!.tokens).toBeUndefined();
  });

  it('mirrors ONE batch per turn, with ids that differ between turns', async () => {
    const s = seam();
    await bind(s);
    await send(s, 'first');
    say(s, RUN1_SYSTEM_INIT, RUN1_TEXT_DELTA, RUN1_RESULT);
    await settle();
    await send(s, 'second');
    say(s, RUN1_TEXT_DELTA, RUN1_RESULT);
    await settle();

    expect(s.ext).toHaveLength(2);
    const idsOf = (i: number) =>
      (s.ext[i]!.params?.messages as Array<Record<string, unknown>>).map((m) => m.id as string);
    // Stable WITHIN a turn (user and assistant share the turn's stamp) and
    // distinct BETWEEN turns — the engine dedupes on exactly these.
    expect(new Set([...idsOf(0), ...idsOf(1)]).size).toBe(4);
  });

  it('still mirrors a CANCELLED turn — the user saw it, so History should too', async () => {
    const s = seam();
    await bind(s);
    await send(s, 'go');
    say(s, RUN1_SYSTEM_INIT, RUN1_TEXT_DELTA);
    await handleClaudeCodeMessage(s.host, { type: 'cancel', sessionId: CELL });
    await settle();

    expect(s.ext).toHaveLength(1);
    const messages = s.ext[0]!.params?.messages as Array<Record<string, unknown>>;
    expect(messages[1]!.text).toBe('PONG');
  });

  it('is BEST EFFORT: an engine that refuses is logged and the chat keeps working', async () => {
    const s = seam({ extFails: true });
    await bind(s);
    await send(s, 'go');
    say(s, RUN1_SYSTEM_INIT, RUN1_TEXT_DELTA, RUN1_RESULT);
    await settle();

    expect(s.logs.some((l) => l.includes('mirror failed'))).toBe(true);
    // The turn itself was never touched: the user's line and the reply are on
    // screen exactly as they would be with no mirror at all.
    expect(s.postsOf('echoUser')).toHaveLength(1);
    expect(s.postsOf('turnDone')).toHaveLength(1);
    await send(s, 'again');
    expect(s.postsOf('echoUser')).toHaveLength(2);
  });

  it('does nothing at all when the cell has no engine session yet', async () => {
    const s = seam({ engineSessionId: null });
    await bind(s);
    await send(s, 'go');
    say(s, RUN1_SYSTEM_INIT, RUN1_TEXT_DELTA, RUN1_RESULT);
    await settle();

    expect(s.ext).toEqual([]);
    expect(s.logs.some((l) => l.includes('mirror failed'))).toBe(false);
  });

  it('does nothing on a host that predates the mirror', async () => {
    const s = seam({ noEngine: true });
    await bind(s);
    await send(s, 'go');
    say(s, RUN1_SYSTEM_INIT, RUN1_TEXT_DELTA, RUN1_RESULT);
    await settle();

    expect(s.ext).toEqual([]);
    expect(s.postsOf('turnDone')).toHaveLength(1);
  });
});

describe('the auto-title reaches the sidebar and the engine, not just the DOM', () => {
  it('drives the panel\'s OWN rename on the first user line', async () => {
    const s = seam();
    await bind(s);
    await send(s, 'fix the parser crash');

    // Still optimistic — the label lands in the same tick even if the engine
    // write is slow or refuses.
    expect(s.postsOf('sessionTitle').at(-1)).toEqual({
      type: 'sessionTitle', sessionId: CELL, title: 'Fix The Parser Crash',
    });
    // And AUTHORITATIVE: `renameSession` is the path a tab double-click takes,
    // and the only one that writes the engine title the History dropdown reads.
    expect(s.redispatched).toEqual([
      { type: 'renameSession', sessionId: CELL, title: 'Fix The Parser Crash' },
    ]);
  });

  it('renames ONCE — a second message must not retitle a chat being read', async () => {
    const s = seam();
    await bind(s);
    await send(s, 'fix the parser crash');
    await send(s, 'now do something else entirely');

    expect(s.redispatched).toHaveLength(1);
    expect(s.postsOf('sessionTitle').at(-1)?.title).toBe('Fix The Parser Crash');
  });
});

describe('the connected line is said once, not once per turn', () => {
  /** The captured init with one fact changed — the shape a re-point produces. */
  function initWithModel(model: string): string {
    const ev = JSON.parse(RUN1_SYSTEM_INIT) as Record<string, unknown>;
    ev.model = model;
    return JSON.stringify(ev);
  }

  const connected = (s: Seam) =>
    s.postsOf('system').filter((p) => String(p.text ?? '').includes('connected'));

  // The child spawns on the FIRST prompt (driver.prompt → start), so a turn has
  // to be sent before there is any stdout to speak of. A respawn is then a
  // SECOND `system/init` on the wire, which is what these replay: the dedupe
  // lives in the per-cell TranslatorState, which outlives any one child, so a
  // second init is the whole of what a park-and-resume looks like from here.
  async function started(over?: Parameters<typeof seam>[0]): Promise<Seam> {
    const s = seam(over);
    await bind(s);
    await send(s, 'go');
    return s;
  }

  it('says it once for a bind, and stays silent when a respawn re-inits identically', async () => {
    const s = await started();
    say(s, RUN1_SYSTEM_INIT);
    expect(connected(s)).toHaveLength(1);

    say(s, RUN1_SYSTEM_INIT);
    expect(connected(s)).toHaveLength(1);
  });

  it('says it AGAIN when a fact it reports has changed', async () => {
    const s = await started();
    say(s, RUN1_SYSTEM_INIT);
    say(s, initWithModel('claude-fable-5'));

    const lines = connected(s);
    expect(lines).toHaveLength(2);
    expect(String(lines[1]!.text)).toContain('claude-fable-5');
  });

  it('keeps restating the live readouts a respawn has to re-establish', async () => {
    const s = await started();
    say(s, RUN1_SYSTEM_INIT);
    say(s, RUN1_SYSTEM_INIT);

    // The meter and the `/` rows are session STATE, not news: a suppressed
    // connected line must not take them with it.
    expect(s.postsOf('passthroughMeter')).toHaveLength(2);
    expect(s.postsOf('passthroughCommands')).toHaveLength(2);
  });
});
