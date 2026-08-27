// promptCapture — the host leaf behind the Instructions pane's "what the model
// actually received" section. Same shape as boardData's leaves, and the same
// thing matters: what happens when it goes wrong. The sharpest case here is the
// one that is NOT wrong — a chat that has never sent a message has no capture,
// and reporting that as an error would read as a broken feature.

import { describe, it, expect } from 'vitest';
import { promptCapturePayload } from '../../../src/dashboard/promptCapture';

const capture = {
  capturedAt: '2026-08-03T09:00:00.000Z',
  model: 'anthropic/claude',
  labeledParts: [{ label: 'env' as const, chars: 4, tokensApprox: 1, text: 'ENV' }],
  finalSystem: [{ chars: 4, tokensApprox: 1, text: 'ENV' }],
  tools: [],
  tokensApproxMethod: 'chars/4' as const,
};

const clientWith = (
  result: unknown,
  calls: Array<{ method: string; params?: Record<string, unknown> }> = [],
  sessionId: string | null = 'ses_live',
) => ({
  currentSessionId: sessionId,
  extMethod: async (method: string, params?: Record<string, unknown>) => {
    calls.push({ method, params });
    return result as Record<string, unknown>;
  },
});

describe('promptCapturePayload', () => {
  it('asks the engine for THIS client’s own session, on the prompt_capture method', async () => {
    const calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
    await promptCapturePayload(clientWith({ sessionId: 'ses_live', capture }, calls));

    expect(calls).toEqual([{ method: 'prompt_capture', params: { sessionId: 'ses_live' } }]);
  });

  it('passes the engine’s capture through verbatim', async () => {
    const out = await promptCapturePayload(clientWith({ sessionId: 'ses_live', capture }));

    expect(out.capture).toEqual(capture);
    expect(out.error).toBeUndefined();
  });

  it('a session that has not sent a turn is an empty answer, NOT an error', async () => {
    const out = await promptCapturePayload(clientWith({ sessionId: 'ses_live', capture: null }));

    expect(out.capture).toBeNull();
    expect(out.error).toBeUndefined();
  });

  it('a client with no engine session yet asks nothing and reports no error', async () => {
    const calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
    const out = await promptCapturePayload(clientWith({}, calls, null));

    expect(calls).toEqual([]);
    expect(out).toEqual({ capture: null });
  });

  it('with no client at all it says a chat is needed — that IS the actionable error', async () => {
    const out = await promptCapturePayload(null);

    expect(out.capture).toBeNull();
    expect(out.error).toContain('Open a chat first');
  });

  it('a throwing engine surfaces the message rather than a silent empty section', async () => {
    const out = await promptCapturePayload({
      currentSessionId: 'ses_live',
      extMethod: async () => {
        throw new Error('method_not_found');
      },
    });

    expect(out.error).toBe('method_not_found');
    expect(out.capture).toBeNull();
  });

  it('a reply missing the lists the view iterates is rejected, not rendered half-built', async () => {
    for (const bad of [
      { sessionId: 'ses_live', capture: { capturedAt: 'x', model: 'm' } },
      { sessionId: 'ses_live', capture: { ...capture, tools: 'lots' } },
      { sessionId: 'ses_live', capture: 'a capture, honest' },
      {},
    ]) {
      expect((await promptCapturePayload(clientWith(bad))).capture).toBeNull();
    }
  });
});
