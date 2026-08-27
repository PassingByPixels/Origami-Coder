// reloadReplay.test.ts — the two RELOAD defects, driven by a REAL replay stream.
//
// FIXTURE PROVENANCE (reloadReplay.fixture.json): captured, not authored. A
// subprocess harness (packages/engine/test/cli/acp/reload-replay.test.ts) spawns
// `origami acp`, creates a session, runs a `read` tool turn, closes that engine
// process, spawns a SECOND one against the same database and calls
// `session/load`. Every `session/update` notification the second process emitted
// is the fixture, verbatim (only `available_commands_update` was dropped — it is
// the command list, not transcript). So this file asserts against what a window
// reload actually receives.
//
// The two defects the stream proves are NOT the engine's:
//   1. the replay DOES carry `tool_call` + `tool_call_update` with the
//      `_meta.origami_tool_name` rider — yet a reloaded chat rendered them as
//      plain text, because the host's message log kept only a title and the
//      pane's restore turned a 'tool' entry into a `system` row;
//   2. the replay carries `session_info_update` with the session's STORED title
//      (engine acp/service.ts emits it on load) — the reason a reopened chat
//      used to fall back to the bare agent name is that nothing sent it.

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { AcpClient, type AcpEventHandlers } from '../../../src/acpClient';
import { archiveLog, logSubagentDone, logToolCall, logToolResult, type SessionMessage } from '../../../src/dashboard/sessionLog';
import { restoreLog, type RestoredEntry } from '../panes/chatRestore';
import { subagentRows } from '../panes/subagentRows';
import { elapsedText } from '../panes/subagentFormat';

type Notification = { sessionId: string; update: Record<string, unknown> };

const REPLAY: Notification[] = JSON.parse(
  readFileSync(path.join(__dirname, 'reloadReplay.fixture.json'), 'utf8'),
);

function noopHandlers(over: Partial<AcpEventHandlers>): AcpEventHandlers {
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

/**
 * Run the captured stream through the REAL acpClient decode, wired to the log
 * exactly as DashboardPanel.ts wires it (`logToolCall` in onToolCallStart,
 * `logToolResult` in onToolCallUpdate). `sessionId` is deliberately left unset
 * on the client: during `loadSession` it IS unset, which is why the router's
 * cross-session guard lets replayed frames through.
 */
async function replayIntoLog(): Promise<{ log: SessionMessage[]; titles: string[] }> {
  const log: SessionMessage[] = [];
  const titles: string[] = [];
  const handlers = noopHandlers({
    onToolCallStart: (args) => {
      logToolCall(log, args as unknown as Record<string, unknown>);
    },
    onToolCallUpdate: (args) => {
      logToolResult(log, args as unknown as Record<string, unknown>);
    },
    onSessionTitle: ({ title }) => {
      titles.push(title);
    },
  });
  const client = new AcpClient(handlers);
  const impl = (client as unknown as { buildClientImpl: () => { sessionUpdate: (p: unknown) => Promise<void> } })
    .buildClientImpl();
  for (const notification of REPLAY) await impl.sessionUpdate(notification);
  return { log, titles };
}

describe('reload defect 1 — a replayed tool call restores as a CARD, not text', () => {
  it('the captured replay really does contain the tool events (guards the engine contract)', () => {
    const kinds = REPLAY.map((n) => n.update.sessionUpdate);
    expect(kinds).toContain('tool_call');
    expect(kinds).toContain('tool_call_update');
    // The rider is what tells the pane which card to draw; without it every
    // replayed call falls to the generic card.
    const call = REPLAY.find((n) => n.update.sessionUpdate === 'tool_call')!;
    expect((call.update._meta as { origami_tool_name?: string }).origami_tool_name).toBe('read');
  });

  it('rebuilds the tool card, with its name, status and output', async () => {
    const { log } = await replayIntoLog();
    const toolEntries = log.filter((m) => m.kind === 'tool');
    expect(toolEntries).toHaveLength(1);
    // The whole point of the fix: the entry keeps the payload, not just a title.
    expect(toolEntries[0].tool?.call.toolCallId).toBe('call_1');
    expect(toolEntries[0].tool?.result).toBeDefined();

    const restored = restoreLog<any>([], log as RestoredEntry[], (() => { let n = 1; return () => n++; })(), 'Tsuru');
    const card = restored.find((m) => m.toolCallId === 'call_1');
    expect(card, 'the replayed call must come back as a tool card').toBeDefined();
    // RED before the fix: `kind` was 'system' and every tool field was absent,
    // which is the "renders as plain text" the owner reported.
    expect(card.kind).toBe('tool');
    expect(card.toolName).toBe('read');
    expect(card.toolStatus).toBe('completed');
    expect(card.toolResult).toContain('capture fixture');
    // A card, not a text row: no restored message may be a `system` row that
    // merely names the tool.
    expect(restored.some((m) => m.kind === 'system' && m.label === 'tool')).toBe(false);
  });

  it('the DISK archive keeps the card but drops the screenshots', () => {
    // The fix must not turn a text-row bug into a multi-megabyte session file:
    // a `browser` result carries data: URIs, and the history pane reads the
    // whole archive back. The card itself survives — only the images go.
    const log: SessionMessage[] = [];
    logToolCall(log, { toolCallId: 'b1', title: 'browser', toolName: 'browser' });
    logToolResult(log, {
      toolCallId: 'b1',
      status: 'completed',
      contentText: 'navigated',
      images: ['data:image/png;base64,AAAA'],
    });
    expect(log[0].tool?.result?.images).toBeDefined();
    const archived = archiveLog(log);
    expect(archived[0].tool?.result?.images).toBeUndefined();
    expect(archived[0].tool?.result?.content).toBe('navigated');
    expect(archived[0].tool?.call.toolCallId).toBe('b1');
    // The live log must NOT be mutated — the open chat still shows its shot.
    expect(log[0].tool?.result?.images).toEqual(['data:image/png;base64,AAAA']);
  });

  it('an OLD log entry with no payload still restores as a text row', () => {
    // Archives written before the fix must keep rendering exactly as they did —
    // the fix must not turn a title-only entry into an empty card.
    const legacy: RestoredEntry[] = [{ kind: 'tool', text: 'read', timestamp: 5 }];
    const restored = restoreLog<any>([], legacy, (() => { let n = 1; return () => n++; })(), 'Tsuru');
    expect(restored).toHaveLength(1);
    expect(restored[0].kind).toBe('system');
    expect(restored[0].label).toBe('tool');
    expect(restored[0].toolCallId).toBeUndefined();
  });
});

// reload defect 3 — a BACKGROUND sub-agent that finished came back RUNNING.
//
// The drawer retires a background row on one field only: `taskDone`
// (subagentEntry.ts `stillOut` — `if (m.taskBackground === true) return
// !m.taskDone`). That marker arrives on its own `subagentDone` channel, not as
// a tool_call_update, and the host used to post it WITHOUT logging it, on the
// reasoning that "the child's result arrives as its own turn". The result turn
// carries the child's OUTPUT but not the terminal fact, so every reload replayed
// a card with no `taskDone` and resurrected a long-dead sub-agent as permanently
// "running" — the symptom the owner reported.
describe('reload defect 3 — a finished background sub-agent stays finished', () => {
  /** A background `task` card, exactly as the host logs one. */
  const backgroundTaskLog = (): SessionMessage[] => {
    const log: SessionMessage[] = [];
    logToolCall(log, { toolCallId: 'call_task', title: 'task', toolName: 'task' });
    logToolResult(log, {
      toolCallId: 'call_task',
      toolName: 'task',
      status: 'completed',
      contentText: 'spawned',
      taskSessionId: 'child-a',
      taskBackground: true,
    });
    return log;
  };

  const restoredCard = (log: SessionMessage[]) =>
    restoreLog<any>([], log as RestoredEntry[], (() => { let n = 1; return () => n++; })(), 'Tsuru')
      .find((m) => m.toolCallId === 'call_task');

  it('the terminal marker survives the log and reaches the restored card', () => {
    const log = backgroundTaskLog();
    logSubagentDone(log, 'child-a', 'completed');

    const card = restoredCard(log);
    expect(card, 'the task card must restore at all').toBeDefined();
    expect(card.taskBackground).toBe(true);
    // RED before the fix: undefined, because nothing ever wrote it to the log.
    expect(card.taskDone).toBe('completed');
    // The rule the drawer actually applies, asserted as the drawer applies it —
    // this is the difference between a retired row and one that runs forever.
    expect(card.taskBackground === true && !card.taskDone).toBe(false);
  });

  it('an error marker restores as an error, not as completed', () => {
    const log = backgroundTaskLog();
    logSubagentDone(log, 'child-a', 'error');
    expect(restoredCard(log).taskDone).toBe('error');
  });

  it('a child that has NOT finished still restores as running', () => {
    // The fix must not retire a row that never got a marker: an agent still
    // working, shown as done, is the worse of the two failures.
    expect(restoredCard(backgroundTaskLog()).taskDone).toBeUndefined();
  });

  it('a marker for an unknown child changes nothing', () => {
    // A marker can outlive its card (a replayed session, a chunk that beat its
    // own tool_call). Stamping the newest card instead would retire the WRONG
    // sub-agent, which is silent and worse than dropping it.
    const log = backgroundTaskLog();
    logSubagentDone(log, 'child-nobody', 'completed');
    expect(restoredCard(log).taskDone).toBeUndefined();
  });
});

// reload defect 4 — every sub-agent row came back reading "0s".
//
// WHY. A window reload reopens each chat through the engine
// (sessionRestore.ts -> createSession(..., engineId)), with NO restored message
// log: the host's log starts EMPTY and is refilled by the `session/load` replay,
// where `logToolCall` stamps `Date.now()`. The captured fixture proves the
// replay carries no time of its own, so `now - stamp` was a few hundred
// milliseconds and `elapsedText` printed `0s` — on a fan-out that had been out
// for an hour and a half, and on the finished rows too.
//
// The fix is a SOURCE: the engine now rides the child's real span
// (`origami_task_started`, plus `origami_task_ended` on the terminal marker for
// a detached child, which `replayMessage` re-emits). This drives the whole
// chain — decode, log, restore, roster — the way a reload drives it.
describe('reload defect 4 — a restored sub-agent reports its REAL duration', () => {
  const START = 1_700_000_000_000;
  const END = START + 5_400_000; // 1h 30m — the owner's own case
  const RELOADED_AT = START + 9_000_000;

  /** The host's log as a reload rebuilds it: a background `task` card off the
   *  replayed tool frames, then the replayed terminal marker. */
  const reloadedLog = (over: { started?: number; ended?: number } = {}): SessionMessage[] => {
    const log: SessionMessage[] = [];
    logToolCall(log, { toolCallId: 'call_task', title: 'task', toolName: 'task' });
    logToolResult(log, {
      toolCallId: 'call_task', toolName: 'task', status: 'completed', contentText: 'spawned',
      taskSessionId: 'child-a', taskBackground: true,
      taskStartedAt: over.started === undefined ? START : over.started,
    });
    logSubagentDone(log, 'child-a', 'completed', over.ended === undefined ? END : over.ended);
    return log;
  };

  const restoredRow = (log: SessionMessage[], now: number) => {
    const messages = restoreLog<any>([], log as RestoredEntry[], (() => { let n = 1; return () => n++; })(), 'Tsuru');
    return subagentRows(messages, now)[0];
  };

  it('the engine stamp survives the log, the restore AND the roster derivation', () => {
    const row = restoredRow(reloadedLog(), RELOADED_AT);
    // RED before the fix: 0 (the card's own stamp is the reload instant, and
    // `now - reloadInstant` is milliseconds), printing as '0s'.
    expect(row.elapsedMs).toBe(END - START);
    expect(elapsedText(row.elapsedMs)).toBe('1h 30m');
  });

  it('the total is SETTLED — it does not grow with the wall clock', () => {
    // A finished row must not keep ageing while a sibling agent holds the
    // drawer's 1s tick open.
    expect(restoredRow(reloadedLog(), RELOADED_AT).elapsedMs)
      .toBe(restoredRow(reloadedLog(), RELOADED_AT + 600_000).elapsedMs);
  });

  it('a child still OUT at reload ages from its real start, never from zero', () => {
    const log: SessionMessage[] = [];
    logToolCall(log, { toolCallId: 'call_task', title: 'task', toolName: 'task' });
    logToolResult(log, {
      toolCallId: 'call_task', toolName: 'task', status: 'completed', contentText: 'spawned',
      taskSessionId: 'child-a', taskBackground: true, taskStartedAt: START,
    });
    const row = restoredRow(log, RELOADED_AT);
    expect(row.state).toBe('running');
    expect(row.elapsedMs).toBe(RELOADED_AT - START);
  });

  it('an OLD engine (no stamps) leaves the live path exactly as it was', () => {
    // The fallback is the card's own build time. It is the LAST resort, not a
    // preference — reaching for it first is what the defect was.
    const log = reloadedLog({ started: undefined as unknown as number, ended: undefined });
    const bare: SessionMessage[] = [];
    logToolCall(bare, { toolCallId: 'c', title: 'task', toolName: 'task' });
    logToolResult(bare, { toolCallId: 'c', toolName: 'task', status: 'completed', taskSessionId: 'child-b', taskBackground: true });
    const messages = restoreLog<any>([], bare as RestoredEntry[], (() => { let n = 1; return () => n++; })(), 'Tsuru');
    const built = messages.find((m: any) => m.toolCallId === 'c').timestamp as number;
    expect(subagentRows(messages, built + 5000)[0].elapsedMs).toBe(5000);
    expect(log.length).toBeGreaterThan(0);
  });
});

// reload defect 5 — a RUNNING sub-agent's log tab said "(no output yet)".
//
// The tab was fed from the webview's forwarded-chunk buffer, which
// DashboardPanel deliberately never writes to `messageLog` ("transient
// progress"). So a reopened chat's buffer is empty by construction, and the tab
// took ONE snapshot at click time and never refreshed. Both halves are retired:
// the module is gone and nothing routes to it. This guards the string itself,
// because the failure the owner saw was a tab that looked like a feature.
describe('reload defect 5 — nothing can print "(no output yet)" again', () => {
  const root = path.resolve(__dirname, '..', '..', '..');
  const src = (rel: string) => readFileSync(path.join(root, rel), 'utf8');

  it('the module that wrote it is gone, and so is every route to it', () => {
    // Deleted rather than left unreachable: a registered scheme nothing opens
    // is a tab waiting to lie again. (Sibling files still NAME the string in
    // their comments, on purpose — that is the record of what went wrong, and
    // is why this asserts against the wiring rather than grepping for text.)
    expect(existsSync(path.join(root, 'src/dashboard/subagentStreamTab.ts'))).toBe(false);
    expect(src('src/extension.ts')).not.toContain('registerSubagentStreamProvider');
    expect(src('src/dashboard/DashboardPanel.ts')).not.toContain('openSubagentStream');
    expect(src('src/dashboard/DashboardPanel.ts')).not.toContain('(no output yet)');
  });

  it('the drawer no longer carries the buffer that tab was fed from', () => {
    // The row shipped the whole untailed stream ONLY for that document. Left
    // in place it is a field nothing reads, and the next reader would assume
    // there is still a full-stream surface somewhere.
    expect(src('webview/dashboard/panes/subagentRows.ts')).not.toContain('stream: m.taskStream');
  });
});

describe('reload defect 2 — the reopened chat learns its stored title', () => {
  it('the replay carries session_info_update, and the client forwards the title', async () => {
    const { titles } = await replayIntoLog();
    // RED before the engine fix: the replay contained NO session_info_update at
    // all, so this array was empty and the row fell back to the agent name.
    expect(titles).toEqual(['E2E Title']);
  });
});
