// Closing a chat must let its engine take its peer heartbeat with it
// (t-kgu05m round 4).
//
// The bug these guard: `dispose()` killed the child outright, so the engine's
// broker finalizer never ran and its heartbeat file stayed on disk naming the
// closed chat as an ATTACHED session. Verified against the real engine on
// 2026-08-13 — after a `kill()` the entry was still there two seconds later,
// still listing the session; after an stdin EOF it was gone in ~60 ms and the
// process exited 0.
//
// The fake child models the two facts of node's ChildProcess this decision
// reads: an `exitCode` that is null until it goes, and a `stdin` whose `end()`
// is the EOF the engine waits on.

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { ENGINE_EXIT_GRACE_MS, shutdownEngine, type ClosableEngine } from '../../../src/engineShutdown';
import { AcpClient, type AcpEventHandlers } from '../../../src/acpClient';

function fakeChild(over: Partial<{ exitCode: number | null; stdin: { end(): void } | null }> = {}) {
  const order: string[] = [];
  let onExit: (() => void) | undefined;
  const child = {
    exitCode: 'exitCode' in over ? (over.exitCode ?? null) : null,
    stdin:
      'stdin' in over
        ? over.stdin
        : {
            end: () => {
              order.push('stdin.end');
            },
          },
    once: (_event: 'exit', listener: () => void) => {
      onExit = listener;
      return child;
    },
    kill: () => {
      order.push('kill');
      return true;
    },
  } satisfies ClosableEngine & { exitCode: number | null };
  return { child, order, exit: () => onExit?.() };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('shutdownEngine — the engine is asked to leave before it is killed', () => {
  it('ends stdin and does NOT kill while the grace is still running', () => {
    const { child, order } = fakeChild();
    shutdownEngine(child);
    expect(order).toEqual(['stdin.end']);
    vi.advanceTimersByTime(ENGINE_EXIT_GRACE_MS - 1);
    // The failure this catches is the whole ticket: a kill here beats the
    // engine to its own heartbeat file and leaves a closed chat advertised.
    expect(order).toEqual(['stdin.end']);
  });

  it('never kills an engine that exits inside the grace', () => {
    const { child, order, exit } = fakeChild();
    shutdownEngine(child);
    exit();
    vi.advanceTimersByTime(ENGINE_EXIT_GRACE_MS * 10);
    expect(order).toEqual(['stdin.end']);
  });

  it('kills a wedged engine once the grace elapses', () => {
    const { child, order } = fakeChild();
    shutdownEngine(child);
    vi.advanceTimersByTime(ENGINE_EXIT_GRACE_MS);
    // Closing a chat must not be able to leave a process behind either.
    expect(order).toEqual(['stdin.end', 'kill']);
  });

  it('kills at once when there is no stdin to close', () => {
    const { child, order } = fakeChild({ stdin: null });
    shutdownEngine(child);
    expect(order).toEqual(['kill']);
  });

  it('touches an already-exited child not at all', () => {
    const { child, order } = fakeChild({ exitCode: 0 });
    shutdownEngine(child);
    vi.advanceTimersByTime(ENGINE_EXIT_GRACE_MS * 10);
    expect(order).toEqual([]);
  });
});

describe('AcpClient.dispose — the shipped caller', () => {
  const handlers = () =>
    ({
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
    }) as unknown as AcpEventHandlers;

  it('asks the engine to close its session rather than killing it outright', () => {
    const client = new AcpClient(handlers());
    const { child, order } = fakeChild();
    (client as unknown as { child: unknown }).child = child;

    client.dispose();

    // Whichever way the close was reached — the user shut a tab, the boot tab
    // was retired after a restore, the window went away — the engine gets its
    // chance to unpublish itself first.
    expect(order).toEqual(['stdin.end']);
    expect((client as unknown as { child: unknown }).child).toBeNull();
  });
});
