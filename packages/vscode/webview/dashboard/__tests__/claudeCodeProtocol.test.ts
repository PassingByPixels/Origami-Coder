// claudeCodeProtocol.test.ts — the Claude Code wire contract.
//
// Every input here is a REAL line the CLI wrote (claudeCodeFixtures.ts, taken
// from a captured live session on this machine). That is the point: the browser
// tool once passed 38/38 against invented tool names, so a contract with an
// external program is tested against what that program actually emitted, never
// against a shape we imagined it emits.
//
// The two variants that are NOT verbatim are marked DERIVED and say what was
// changed and why — both are edits to one field of a real line, because the
// captured turn used no sub-agent and produced no malformed output.

import { describe, expect, it } from 'vitest';
import {
  CLI_PERMISSION_MODE, FORBIDDEN_FLAGS, LineSplitter, allowResponse, assertNoBypass, buildArgs,
  childEnv, controlAck, controlRequestOf, denyResponse, initializeRequest, interruptRequest,
  isSubagentEvent, parseLine, permissionAskOf, resultUsage, sessionIdOf, userMessage,
} from '../../../src/claudeCode/protocol';
import {
  RUN1_ASSISTANT_TEXT_BLOCK, RUN1_INITIALIZE_RESPONSE, RUN1_MESSAGE_START, RUN1_RATE_LIMIT_EVENT,
  RUN1_RESULT, RUN1_STDOUT_LINES, RUN1_SYSTEM_INIT, RUN1_SYSTEM_STATUS_BEFORE_INIT, RUN1_TEXT_DELTA,
} from './claudeCodeFixtures';

const SESSION = 'c6bab4a9-9d8a-4bf1-855d-9d7e146f884a';

describe('buildArgs — the vector the spike proved works on win32', () => {
  it('carries the bidirectional stream-json contract and no -p', () => {
    expect(buildArgs({ mode: 'supervised' })).toEqual([
      '--output-format', 'stream-json',
      '--verbose',
      '--input-format', 'stream-json',
      '--include-partial-messages',
      '--permission-prompt-tool', 'stdio',
      '--setting-sources=user,project,local',
      '--permission-mode', 'default',
    ]);
  });

  it('maps every supported mode to a CLI mode, and none of them is a bypass', () => {
    expect(CLI_PERMISSION_MODE).toEqual({ supervised: 'default', acceptEdits: 'acceptEdits', auto: 'acceptEdits', plan: 'plan' });
    for (const mode of ['supervised', 'acceptEdits', 'auto'] as const) {
      const args = buildArgs({ mode });
      for (const bad of FORBIDDEN_FLAGS) expect(args.join(' ')).not.toContain(bad);
    }
  });

  it('appends model and resume only when asked', () => {
    const args = buildArgs({ mode: 'acceptEdits', model: 'haiku', resumeSessionId: SESSION });
    expect(args.slice(-4)).toEqual(['--model', 'haiku', '--resume', SESSION]);
    expect(buildArgs({ mode: 'acceptEdits' })).not.toContain('--resume');
  });

  it('refuses any vector carrying a permission-bypass flag', () => {
    for (const bad of FORBIDDEN_FLAGS) {
      expect(() => assertNoBypass(['--verbose', bad])).toThrow(/permission-bypass/);
    }
    expect(() => assertNoBypass(['--permission-mode', 'bypassPermissions'])).toThrow();
    expect(() => assertNoBypass(buildArgs({ mode: 'supervised' }))).not.toThrow();
  });
});

describe('childEnv — inherit everything except our own keys', () => {
  it('strips CLAUDE* and ORIGAMI_*, keeps the rest, drops undefined', () => {
    const env = childEnv({
      PATH: '/usr/bin', HOME: '/home/u',
      CLAUDE_CODE_SSE_PORT: '1', CLAUDECODE: '1',
      ORIGAMI_API_BASE: 'http://x', ORIGAMI_RG_PATH: 'rg',
      EMPTY: undefined,
    });
    expect(env).toEqual({ PATH: '/usr/bin', HOME: '/home/u' });
  });

  it('injects nothing — the CLI authenticates itself from ~/.claude', () => {
    expect(Object.keys(childEnv({ PATH: 'p' }))).toEqual(['PATH']);
  });

  it('keeps the user\'s own CLAUDE_CODE_ENABLE_* toggles, and only those', () => {
    // A capability the user turned on in their own shell — the Task todo tools
    // among them — is not an identity, a credential or a nested-session marker,
    // which are the three things the scrub exists for. Scrubbing it silently
    // disabled a setting the user had deliberately set.
    const env = childEnv({
      CLAUDE_CODE_ENABLE_TODO_TOOLS: '1', CLAUDE_CODE_ENABLE_TELEMETRY: '0',
      CLAUDE_API_KEY: 'sk-secret', CLAUDE_CODE_OAUTH_TOKEN: 'oauth', CLAUDE_CODE_SSE_PORT: '1',
      CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'cli', ORIGAMI_API_BASE: 'http://x',
    });
    expect(env).toEqual({ CLAUDE_CODE_ENABLE_TODO_TOOLS: '1', CLAUDE_CODE_ENABLE_TELEMETRY: '0' });
  });
});

describe('LineSplitter — stdout arrives in arbitrary chunks', () => {
  it('reassembles a real line split mid-JSON', () => {
    const s = new LineSplitter();
    const cut = 40;
    expect(s.push(RUN1_TEXT_DELTA.slice(0, cut))).toEqual([]);
    expect(s.push(`${RUN1_TEXT_DELTA.slice(cut)}\n`)).toEqual([RUN1_TEXT_DELTA]);
  });

  it('splits a multi-line chunk and holds the trailing partial', () => {
    const s = new LineSplitter();
    const chunk = `${RUN1_SYSTEM_STATUS_BEFORE_INIT}\n${RUN1_TEXT_DELTA}\n${RUN1_RESULT.slice(0, 20)}`;
    expect(s.push(chunk)).toEqual([RUN1_SYSTEM_STATUS_BEFORE_INIT, RUN1_TEXT_DELTA]);
    expect(s.flush()).toEqual([RUN1_RESULT.slice(0, 20)]);
  });

  it('tolerates CRLF', () => {
    const s = new LineSplitter();
    expect(s.push(`${RUN1_TEXT_DELTA}\r\n`)).toEqual([RUN1_TEXT_DELTA]);
  });
});

describe('parseLine — lenient, because a stray banner must not kill a session', () => {
  it('decodes every captured line', () => {
    for (const line of RUN1_STDOUT_LINES) {
      const ev = parseLine(line);
      expect(ev, line.slice(0, 60)).not.toBeNull();
      expect(typeof ev!.type).toBe('string');
    }
  });

  it('returns null for noise instead of throwing', () => {
    for (const junk of ['', '   ', 'Debugger attached.', '{not json', '[1,2]', 'null', '{"no":"type"}']) {
      expect(parseLine(junk)).toBeNull();
    }
  });
});

describe('event readers', () => {
  it('adopts the session id the CLI stamps on its own events', () => {
    expect(sessionIdOf(parseLine(RUN1_SYSTEM_INIT)!)).toBe(SESSION);
    expect(sessionIdOf(parseLine(RUN1_RESULT)!)).toBe(SESSION);
    // The initialize response carries no session id — the adopter must cope.
    expect(sessionIdOf(parseLine(RUN1_INITIALIZE_RESPONSE)!)).toBeUndefined();
  });

  it('treats a null parent_tool_use_id as main-thread and a string as a sub-agent', () => {
    expect(isSubagentEvent(parseLine(RUN1_TEXT_DELTA)!)).toBe(false);
    expect(isSubagentEvent(parseLine(RUN1_ASSISTANT_TEXT_BLOCK)!)).toBe(false);
    // DERIVED from RUN1_TEXT_DELTA: the captured turn spawned no sub-agent, so
    // the one field that marks one is substituted into a real line.
    const child = RUN1_TEXT_DELTA.replace('"parent_tool_use_id":null', '"parent_tool_use_id":"toolu_01ABC"');
    expect(child).not.toBe(RUN1_TEXT_DELTA);
    expect(isSubagentEvent(parseLine(child)!)).toBe(true);
  });

  it('reads a control_request and accepts the sdk_ alias', () => {
    const init = parseLine(RUN1_INITIALIZE_RESPONSE)!;
    expect(controlRequestOf(init)).toBeNull(); // a RESPONSE is not a request
    const req = { type: 'control_request', request_id: 'r1', request: { subtype: 'mcp_message' } };
    expect(controlRequestOf(req)).toEqual({ requestId: 'r1', subtype: 'mcp_message', request: { subtype: 'mcp_message' } });
    expect(controlRequestOf({ ...req, type: 'sdk_control_request' })?.requestId).toBe('r1');
    expect(permissionAskOf(req)).toBeNull();
  });

  it('reads usage and the context window out of `result`', () => {
    const usage = resultUsage(parseLine(RUN1_RESULT)!)!;
    // 10 fresh input + 0 cache read + 36,352 cache creation, exactly as the
    // captured line reports them.
    expect(usage.tokensUsed).toBe(36362);
    // From modelUsage['claude-haiku-4-5-20251001'].contextWindow — the CLI
    // tells us, so there is no model table here to go stale.
    expect(usage.contextWindow).toBe(200000);
    expect(usage.costUsd).toBeCloseTo(0.073633, 6);
    expect(usage.isError).toBe(false);
    expect(usage.stopReason).toBe('end_turn');
    expect(resultUsage(parseLine(RUN1_MESSAGE_START)!)).toBeNull();
    expect(resultUsage(parseLine(RUN1_RATE_LIMIT_EVENT)!)).toBeNull();
  });
});

describe('frame builders — what we write back on stdin', () => {
  it('answers a permission ask in the CLI control_response shape', () => {
    expect(allowResponse('r7', { file_path: 'a.txt' })).toEqual({
      type: 'control_response',
      response: { subtype: 'success', request_id: 'r7', response: { behavior: 'allow', updatedInput: { file_path: 'a.txt' } } },
    });
    expect(denyResponse('r7')).toEqual({
      type: 'control_response',
      response: { subtype: 'success', request_id: 'r7', response: { behavior: 'deny', message: 'User declined tool execution.' } },
    });
  });

  it('acks an unknown control subtype so the child never stalls', () => {
    expect(controlAck('r9')).toEqual({ type: 'control_response', response: { subtype: 'success', request_id: 'r9', response: {} } });
  });

  it('sends the first turn with an empty session id and echoes the adopted one after', () => {
    expect(userMessage('hi')).toEqual({
      type: 'user', session_id: '', parent_tool_use_id: null,
      message: { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    });
    expect((userMessage('hi', SESSION) as { session_id: string }).session_id).toBe(SESSION);
  });

  it('builds the handshake and the interrupt', () => {
    expect(initializeRequest('o_1')).toEqual({ type: 'control_request', request_id: 'o_1', request: { subtype: 'initialize' } });
    expect(interruptRequest('o_2')).toEqual({ type: 'control_request', request_id: 'o_2', request: { subtype: 'interrupt' } });
  });
});
