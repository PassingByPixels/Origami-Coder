// `origami acp` spawn-args guard.
//
// The engine IS the bridge now: AcpClient.start spawns the `origami` CLI's
// `acp` subcommand with the workspace cwd, and the engine endpoint comes
// from config (origami.json), NOT a threaded ORIGAMI_API_BASE env (the
// deleted v1 boundary). These tests pin that wiring: the args carry
// `['acp','--cwd',<cwd>]`, and a passed engineUrl is NOT injected into the
// child env — a regression to the old env-threading would fail here.
//
// We mock node:child_process so no binary launches, and the ACP SDK so no
// real JSON-RPC handshake runs — leaving the spawn wiring under test.

import { describe, expect, it, vi, beforeEach } from 'vitest';

// --- capture spawn args/options without launching a process ---
const { spawnMock } = vi.hoisted(() => {
  const child: any = {
    stdin: { on() {}, once() {}, write() {}, end() {} },
    stdout: { on() {}, once() {}, pipe() {}, setEncoding() {} },
    stderr: { on() {}, once() {}, setEncoding() {} },
    on() { return child; },
    kill() {},
  };
  const fn = vi.fn(() => child);
  return { spawnMock: fn };
});

vi.mock('node:child_process', () => ({ spawn: spawnMock, default: { spawn: spawnMock } }));

// Stub the ACP SDK so start() resolves a session id without real I/O.
vi.mock('@agentclientprotocol/sdk', () => {
  const PROTOCOL_VERSION = 1;
  const ndJsonStream = () => ({});
  class ClientSideConnection {
    constructor(_factory: unknown, _stream: unknown) {}
    async initialize() { return { protocolVersion: 1 }; }
    async newSession() { return { sessionId: 'sess-test', configOptions: [] }; }
  }
  return {
    PROTOCOL_VERSION, ndJsonStream, ClientSideConnection,
    default: { PROTOCOL_VERSION, ndJsonStream, ClientSideConnection },
  };
});

// Web stream adapters return throwaway objects (the SDK is stubbed).
vi.mock('node:stream', () => {
  const Readable = { toWeb: () => ({}) };
  const Writable = { toWeb: () => ({}) };
  return { Readable, Writable, default: { Readable, Writable } };
});

import { AcpClient, type AcpEventHandlers } from '../../../src/acpClient';

function noopHandlers(): AcpEventHandlers {
  return {
    onAgentMessageChunk: vi.fn(), onAgentImageChunk: vi.fn(),
    onToolCallStart: vi.fn(), onToolCallUpdate: vi.fn(),
    onPermissionRequest: vi.fn(), onAvailableCommands: vi.fn(),
    onPlanStatus: vi.fn(), onPlanReady: vi.fn(),
    onBestOfNComplete: vi.fn(), onTaskShape: vi.fn(), onTodoUpdate: vi.fn(),
    onArbiterDecision: vi.fn(), onTurnEnd: vi.fn(), onAssessmentUpdate: vi.fn(),
    onFeedMessage: vi.fn(), onClose: vi.fn(), onError: vi.fn(),
  };
}

/** The most recent spawn call: [binary, args, opts]. */
function lastSpawn(): [string, string[], any] {
  const calls = spawnMock.mock.calls;
  return calls[calls.length - 1] as [string, string[], any];
}

describe('AcpClient.start — spawns `origami acp --cwd <cwd>`', () => {
  beforeEach(() => {
    spawnMock.mockClear();
    delete process.env.ORIGAMI_API_BASE;
  });

  it('spawns the acp subcommand with the workspace cwd as the arg', async () => {
    const client = new AcpClient(noopHandlers());
    await client.start('/tmp/ws', 'http://192.0.2.10:1234/v1');

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [, args, opts] = lastSpawn();
    // The load-bearing wiring: the engine's `acp` subcommand stands up the
    // server itself; the cwd scopes config + history resolution.
    expect(args).toEqual(['acp', '--cwd', '/tmp/ws']);
    expect(opts.cwd).toBe('/tmp/ws');
  });

  it('does NOT thread the engineUrl into the child env (config-driven, not ORIGAMI_API_BASE)', async () => {
    const client = new AcpClient(noopHandlers());
    await client.start('/tmp/ws', 'http://new-endpoint:1234/v1');

    const [, , opts] = lastSpawn();
    // The deleted v1 boundary: the engine URL must NOT be injected as an
    // ORIGAMI_API_BASE override. Re-adding the old env-threading breaks this.
    expect(opts.env.ORIGAMI_API_BASE).toBeUndefined();
  });

  it('inherits a pre-existing ORIGAMI_API_BASE untouched (neither injects nor strips)', async () => {
    process.env.ORIGAMI_API_BASE = 'http://setx-endpoint:1234/v1';
    const client = new AcpClient(noopHandlers());
    await client.start('/tmp/ws');

    const [, , opts] = lastSpawn();
    // start() passes process.env straight through, so a value already in
    // the environment is simply inherited.
    expect(opts.env.ORIGAMI_API_BASE).toBe('http://setx-endpoint:1234/v1');
  });
});
