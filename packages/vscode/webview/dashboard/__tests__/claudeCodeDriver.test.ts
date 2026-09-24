// claudeCodeDriver.test.ts — the child's lifecycle, against a scripted fake.
//
// The fake is the reason driver.ts declares `spawn` as an injectable seam. What
// it feeds the driver is REAL CLI output (claudeCodeFixtures.ts), so these tests
// exercise the same bytes the live smokes did; what it records is what we WROTE
// back, which is the half a transcript cannot show you.
//
// One shape here is not captured: the `can_use_tool` control_request. Both live
// runs on this machine were pre-approved by the user's own settings (a
// 784-entry permissions.allow), so the CLI never asked. That frame is built
// from the contract instead — monocode's verified reader, and the same answer
// frame the spike script wrote — and the test that uses it says so at the call.

import { describe, expect, it, vi } from 'vitest';
import { ClaudeCodeDriver, type SpawnChild } from '../../../src/claudeCode/driver';
import type { ClaudeEvent } from '../../../src/claudeCode/protocol';
import { RUN1_RESULT, RUN1_SYSTEM_INIT, RUN1_TEXT_DELTA, RUN2_BLOCK_START_TOOL_USE } from './claudeCodeFixtures';
import { FakeChild, canUseTool } from './claudeCodeFakeChild';

const SESSION = 'c6bab4a9-9d8a-4bf1-855d-9d7e146f884a';

interface Harness {
  driver: ClaudeCodeDriver;
  child(): FakeChild;
  spawns: Array<{ command: string; args: readonly string[]; opts: { cwd: string; env: Record<string, string>; windowsHide: boolean } }>;
  events: ClaudeEvent[];
  asks: Array<{ requestId: string; toolName: string; input: Record<string, unknown> }>;
  exits: Array<{ reason: string; expected: boolean }>;
  logs: string[];
}

function harness(opts: Partial<ConstructorParameters<typeof ClaudeCodeDriver>[0]> = {}): Harness {
  const children: FakeChild[] = [];
  const spawns: Harness['spawns'] = [];
  const spawn: SpawnChild = (command, args, o) => {
    spawns.push({ command, args, opts: o });
    const c = new FakeChild(); children.push(c); return c;
  };
  const events: ClaudeEvent[] = [];
  const asks: Harness['asks'] = [];
  const exits: Harness['exits'] = [];
  const logs: string[] = [];
  const driver = new ClaudeCodeDriver(
    { binary: 'C:\\claude.exe', cwd: 'C:\\repo', mode: 'supervised', idleParkMs: 0, env: { PATH: 'p', CLAUDECODE: '1', ORIGAMI_API_BASE: 'x' }, spawn, ...opts },
    {
      onEvent: (ev) => events.push(ev),
      onPermissionAsk: (a) => asks.push(a),
      onExit: (reason, expected) => exits.push({ reason, expected }),
      onLog: (l) => logs.push(l),
    },
  );
  return { driver, child: () => children[children.length - 1]!, spawns, events, asks, exits, logs };
}

describe('spawn', () => {
  it('spawns the binary directly with the built vector, scrubbed env and windowsHide', () => {
    const h = harness();
    h.driver.prompt('hello');
    expect(h.spawns).toHaveLength(1);
    expect(h.spawns[0]!.command).toBe('C:\\claude.exe');
    expect(h.spawns[0]!.args).toEqual(h.driver.args());
    expect(h.spawns[0]!.opts).toMatchObject({ cwd: 'C:\\repo', windowsHide: true });
    // No CLAUDE*, no ORIGAMI_*, nothing injected.
    expect(h.spawns[0]!.opts.env).toEqual({ PATH: 'p' });
  });

  it('handshakes, then sends the turn with an empty session id', () => {
    const h = harness();
    h.driver.prompt('hello');
    const frames = h.child().frames();
    expect(frames[0]).toEqual({ type: 'control_request', request_id: 'o_1', request: { subtype: 'initialize' } });
    expect(frames[1]).toMatchObject({ type: 'user', session_id: '', parent_tool_use_id: null });
  });

  it('adopts the CLI\'s session id and echoes it on the next turn', () => {
    const h = harness();
    h.driver.prompt('one');
    h.child().say(`${RUN1_SYSTEM_INIT}\n`);
    expect(h.driver.sessionId).toBe(SESSION);
    h.driver.prompt('two');
    expect(h.child().frames().at(-1)).toMatchObject({ type: 'user', session_id: SESSION });
  });

  it('reports a spawn failure as an unexpected exit instead of throwing', () => {
    const boom: SpawnChild = () => { throw new Error('ENOENT'); };
    const h = harness({ spawn: boom });
    h.driver.prompt('hi');
    expect(h.exits).toEqual([{ reason: expect.stringContaining('ENOENT') as unknown as string, expected: false }]);
  });
});

describe('the stdout pump', () => {
  it('decodes real lines arriving in arbitrary chunks, in order', () => {
    const h = harness();
    h.driver.prompt('hi');
    const c = h.child();
    const joined = `${RUN1_SYSTEM_INIT}\n${RUN1_TEXT_DELTA}\n`;
    c.say(joined.slice(0, 900));
    c.say(joined.slice(900));
    expect(h.events.map((e) => e.type)).toEqual(['system', 'stream_event']);
  });

  it('logs non-JSON stdout rather than dropping it silently or dying', () => {
    const h = harness();
    h.driver.prompt('hi');
    h.child().say('Debugger listening on ws://127.0.0.1\n');
    expect(h.events).toEqual([]);
    expect(h.logs.some((l) => l.includes('non-JSON stdout'))).toBe(true);
  });

  it('forwards stderr to the log, per line', () => {
    const h = harness();
    h.driver.prompt('hi');
    h.child().err('warn: something\nwarn: else\n');
    expect(h.logs.filter((l) => l.includes('warn:'))).toHaveLength(2);
  });
});

describe('permissions', () => {
  it('surfaces can_use_tool to the UI and writes the DENY the UI chose', () => {
    const h = harness();
    h.driver.prompt('write a file');
    h.child().say(`${canUseTool('req_1', 'Write', { file_path: 'a.txt' })}\n`);
    expect(h.asks).toEqual([{ requestId: 'req_1', toolName: 'Write', input: { file_path: 'a.txt' } }]);
    // The ask is NOT an event: it never reaches the transcript as a row.
    expect(h.events).toEqual([]);
    h.driver.answerPermission('req_1', false, { file_path: 'a.txt' });
    expect(h.child().frames().at(-1)).toEqual({
      type: 'control_response',
      response: { subtype: 'success', request_id: 'req_1', response: { behavior: 'deny', message: 'User declined tool execution.' } },
    });
  });

  it('writes an ALLOW that echoes the tool input back', () => {
    const h = harness();
    h.driver.prompt('go');
    h.child().say(`${canUseTool('req_2', 'Read', { file_path: 'b.ts' })}\n`);
    h.driver.answerPermission('req_2', true, { file_path: 'b.ts' });
    expect(h.child().frames().at(-1)).toMatchObject({
      response: { request_id: 'req_2', response: { behavior: 'allow', updatedInput: { file_path: 'b.ts' } } },
    });
  });

  it('ignores an answer for an ask it is not waiting on', () => {
    const h = harness();
    h.driver.prompt('go');
    const before = h.child().written.length;
    h.driver.answerPermission('never-asked', true, {});
    expect(h.child().written.length).toBe(before);
  });

  it('auto mode answers the ask itself and never bothers the UI', () => {
    const h = harness({ mode: 'auto' });
    h.driver.prompt('go');
    h.child().say(`${canUseTool('req_3', 'Bash', { command: 'ls' })}\n`);
    expect(h.asks).toEqual([]);
    expect(h.child().frames().at(-1)).toMatchObject({ response: { response: { behavior: 'allow' } } });
    // …and it is still not a bypass: the vector says acceptEdits.
    expect(h.driver.args()).toContain('acceptEdits');
    expect(h.driver.args().join(' ')).not.toContain('bypass');
  });

  it('acks an unknown control subtype so the child cannot stall', () => {
    const h = harness();
    h.driver.prompt('go');
    h.child().say(`${JSON.stringify({ type: 'control_request', request_id: 'req_9', request: { subtype: 'mcp_message' } })}\n`);
    expect(h.child().frames().at(-1)).toEqual({ type: 'control_response', response: { subtype: 'success', request_id: 'req_9', response: {} } });
    expect(h.events).toEqual([]);
  });
});

describe('interrupt', () => {
  it('asks the child to stop AND seals every parked ask locally', () => {
    const h = harness();
    h.driver.prompt('long job');
    h.child().say(`${canUseTool('req_4', 'Bash', {})}\n`);
    h.driver.interrupt();
    const frames = h.child().frames();
    expect(frames.at(-2)).toMatchObject({ type: 'control_request', request: { subtype: 'interrupt' } });
    // The parked ask is denied rather than left blocking the child forever.
    expect(frames.at(-1)).toMatchObject({ response: { request_id: 'req_4', response: { behavior: 'deny', message: 'Interrupted by the user.' } } });
  });
});

describe('lifecycle', () => {
  it('parks after an idle turn and resumes the SAME conversation on the next prompt', () => {
    vi.useFakeTimers();
    try {
      const h = harness({ idleParkMs: 1000 });
      h.driver.prompt('one');
      h.child().say(`${RUN1_RESULT}\n`);
      vi.advanceTimersByTime(1001);
      expect(h.exits).toEqual([{ reason: expect.stringContaining('exited') as unknown as string, expected: true }]);
      expect(h.driver.running).toBe(false);
      h.driver.prompt('two');
      expect(h.spawns).toHaveLength(2);
      expect(h.spawns[1]!.args).toContain('--resume');
      expect(h.spawns[1]!.args).toContain(SESSION);
    } finally { vi.useRealTimers(); }
  });

  it('does not park while a turn is still open', () => {
    vi.useFakeTimers();
    try {
      const h = harness({ idleParkMs: 1000 });
      h.driver.prompt('one');
      h.child().say(`${RUN1_RESULT}\n`);      // arms the park
      h.driver.prompt('two');                  // …and the next turn disarms it
      vi.advanceTimersByTime(5000);
      expect(h.driver.running).toBe(true);
      expect(h.exits).toEqual([]);
    } finally { vi.useRealTimers(); }
  });

  it('respawns on a settings change once the turn it interrupted has ENDED', () => {
    const h = harness();
    h.driver.prompt('one');
    h.child().say(`${RUN1_SYSTEM_INIT}\n`);
    h.driver.applySettings({ model: 'sonnet' });
    // t-d94nra: this used to kill the child WHERE THE CHANGE ARRIVED, mid-turn. The CLI reads
    // --model and --permission-mode only at spawn, so the park could never have applied to the
    // running turn anyway — all it did was destroy it. Deferred now.
    expect(h.exits).toEqual([]);
    expect(h.driver.running).toBe(true);
    h.child().say(`${RUN1_RESULT}\n`);
    expect(h.exits.at(-1)!.expected).toBe(true);
    h.driver.prompt('two');
    expect(h.spawns[1]!.args).toEqual(expect.arrayContaining(['--model', 'sonnet', '--resume', SESSION]));
  });

  it('applies a deferred settings park on the next PROMPT when the turn never closed', () => {
    const h = harness();
    h.driver.prompt('one');
    h.child().say(`${RUN1_SYSTEM_INIT}\n`);
    h.driver.applySettings({ model: 'sonnet' });
    // No `result` ever arrives (a queued send, a turn the CLI never closed). The change must not
    // be lost: the next prompt parks first, so it runs under the settings the user asked for.
    h.driver.prompt('two');
    expect(h.spawns).toHaveLength(2);
    expect(h.spawns[1]!.args).toEqual(expect.arrayContaining(['--model', 'sonnet', '--resume', SESSION]));
  });

  it('reports an exit nobody asked for as unexpected', () => {
    const h = harness();
    h.driver.prompt('one');
    h.child().emitExit(1, null);
    expect(h.exits).toEqual([{ reason: expect.stringContaining('code=1') as unknown as string, expected: false }]);
  });

  it('refuses to prompt after dispose', () => {
    const h = harness();
    h.driver.prompt('one');
    h.driver.dispose();
    expect(() => h.driver.prompt('two')).toThrow(/after dispose/);
  });

  it('drains a final line the child wrote without a trailing newline', () => {
    const h = harness();
    h.driver.prompt('one');
    h.child().say(RUN2_BLOCK_START_TOOL_USE); // no \n
    expect(h.events).toEqual([]);
    h.child().emitExit(0, null);
    expect(h.events.map((e) => e.type)).toEqual(['stream_event']);
  });
});
