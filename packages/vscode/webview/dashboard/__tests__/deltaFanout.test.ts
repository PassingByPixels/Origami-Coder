// The post() delta-batching + solo-session filter (src/dashboard/deltaFanout.ts,
// t-tc2rlo #9). A streaming turn used to post() once per model chunk — hundreds
// per turn — to every attached webview, including a popped-out solo tab pinned
// to a DIFFERENT chat that only ever ignored the message. DeltaFanout coalesces
// same-key streaming deltas into one post per frame and drops a mismatched
// per-session message before it is ever serialized.

import { describe, expect, it, vi } from 'vitest';
import { DeltaFanout } from '../../../src/dashboard/deltaFanout';

/** Every id is an open chat: the cases below that are about chat traffic. */
const ANY_CHAT = (): boolean => true;

describe('DeltaFanout — solo-session filter', () => {
  it('drops a per-session message for a view solo\'d to a different session', () => {
    const fanout = new DeltaFanout(ANY_CHAT);
    const send = vi.fn();
    fanout.route({} as never, { type: 'toolCall', sessionId: 'ses_a' }, 'ses_b', send);
    expect(send).not.toHaveBeenCalled();
  });

  it('delivers a per-session message for a view solo\'d to the SAME session', () => {
    const fanout = new DeltaFanout(ANY_CHAT);
    const send = vi.fn();
    fanout.route({} as never, { type: 'toolCall', sessionId: 'ses_a' }, 'ses_a', send);
    expect(send).toHaveBeenCalledWith({ type: 'toolCall', sessionId: 'ses_a' });
  });

  it('never filters a message with no sessionId (broadcasts) even for a solo view', () => {
    const fanout = new DeltaFanout(ANY_CHAT);
    const send = vi.fn();
    fanout.route({} as never, { type: 'spendUpdate', total: 5 }, 'ses_b', send);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('the primary host (no solo mapping, undefined) sees every session', () => {
    const fanout = new DeltaFanout(ANY_CHAT);
    const send = vi.fn();
    fanout.route({} as never, { type: 'toolCall', sessionId: 'ses_a' }, undefined, send);
    fanout.route({} as never, { type: 'toolCall', sessionId: 'ses_b' }, undefined, send);
    expect(send).toHaveBeenCalledTimes(2);
  });

  // t-tydjkm. A popped-out chat tab opens a sub-agent's transcript; the reply
  // (DashboardPanel.ts `subagentTranscriptData`) carries the CHILD's session id,
  // which is never the tab's solo chat. Dropping it left the panel on
  // "Loading transcript…" for ever. Only another OPEN CHAT's traffic is dropped.
  it('delivers a reply keyed on a session that is not an open chat (a sub-agent child)', () => {
    const fanout = new DeltaFanout((id) => id === 'ses_parent' || id === 'ses_other_chat');
    const send = vi.fn();
    const msg = { type: 'subagentTranscriptData', sessionId: 'ses_child', found: true, entries: [] };
    fanout.route({} as never, msg, 'ses_parent', send);
    expect(send).toHaveBeenCalledWith(msg);
  });

  it('still drops another open chat\'s traffic when the chat predicate is given', () => {
    const fanout = new DeltaFanout((id) => id === 'ses_parent' || id === 'ses_other_chat');
    const send = vi.fn();
    fanout.route({} as never, { type: 'toolCall', sessionId: 'ses_other_chat' }, 'ses_parent', send);
    expect(send).not.toHaveBeenCalled();
  });
});

describe('DeltaFanout — batches streaming deltas, preserves order', () => {
  it('concatenates same-key agentText chunks arriving within one frame into ONE post', () => {
    vi.useFakeTimers();
    try {
      const fanout = new DeltaFanout(ANY_CHAT);
      const view = {} as never;
      const send = vi.fn();
      fanout.route(view, { type: 'agentText', text: 'Hel', messageId: 'm1', sessionId: 'ses_a' }, undefined, send);
      fanout.route(view, { type: 'agentText', text: 'lo, ', messageId: 'm1', sessionId: 'ses_a' }, undefined, send);
      fanout.route(view, { type: 'agentText', text: 'world', messageId: 'm1', sessionId: 'ses_a' }, undefined, send);
      expect(send, 'nothing sent before the frame elapses').not.toHaveBeenCalled();

      vi.advanceTimersByTime(16);

      expect(send).toHaveBeenCalledTimes(1);
      expect(send).toHaveBeenCalledWith({ type: 'agentText', text: 'Hello, world', messageId: 'm1', sessionId: 'ses_a' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps DIFFERENT keys (session, child, message) in separate buffers', () => {
    vi.useFakeTimers();
    try {
      const fanout = new DeltaFanout(ANY_CHAT);
      const view = {} as never;
      const send = vi.fn();
      fanout.route(view, { type: 'agentText', text: 'A', messageId: 'm1', sessionId: 'ses_a' }, undefined, send);
      fanout.route(view, { type: 'agentText', text: 'B', messageId: 'm2', sessionId: 'ses_a' }, undefined, send);
      fanout.route(view, { type: 'subagentChunk', text: 'C', sessionId: 'ses_a', childSessionId: 'child_1' }, undefined, send);

      vi.advanceTimersByTime(16);

      expect(send).toHaveBeenCalledTimes(3);
      expect(send).toHaveBeenCalledWith(expect.objectContaining({ text: 'A', messageId: 'm1' }));
      expect(send).toHaveBeenCalledWith(expect.objectContaining({ text: 'B', messageId: 'm2' }));
      expect(send).toHaveBeenCalledWith(expect.objectContaining({ text: 'C', childSessionId: 'child_1' }));
    } finally {
      vi.useRealTimers();
    }
  });

  it('a non-delta message flushes pending deltas for that view FIRST, preserving replay order', () => {
    vi.useFakeTimers();
    try {
      const fanout = new DeltaFanout(ANY_CHAT);
      const view = {} as never;
      const order: unknown[] = [];
      const send = (m: unknown) => order.push(m);

      fanout.route(view, { type: 'agentText', text: 'Hel', messageId: 'm1', sessionId: 'ses_a' }, undefined, send);
      fanout.route(view, { type: 'agentText', text: 'lo', messageId: 'm1', sessionId: 'ses_a' }, undefined, send);
      // A tool call arrives mid-stream (the model called a tool between two text
      // chunks, or the same turn also posts a toolCall update) — it must not be
      // delayed behind the delta's frame timer, and the delta it interrupted must
      // still go out BEFORE it, not after.
      fanout.route(view, { type: 'toolCall', toolCallId: 't1', sessionId: 'ses_a' }, undefined, send);
      fanout.route(view, { type: 'agentText', text: '!', messageId: 'm1', sessionId: 'ses_a' }, undefined, send);

      vi.advanceTimersByTime(16);

      // Unbatched, this exact interleaving would have replayed as: "Hel", "lo",
      // toolCall, "!". Batched, the first burst collapses to one post but the
      // ORDER relative to the interrupting message is unchanged, and the chunk
      // after it is its own (later) post.
      expect(order).toEqual([
        { type: 'agentText', text: 'Hello', messageId: 'm1', sessionId: 'ses_a' },
        { type: 'toolCall', toolCallId: 't1', sessionId: 'ses_a' },
        { type: 'agentText', text: '!', messageId: 'm1', sessionId: 'ses_a' },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('dispose() drops pending state for a torn-down view without sending it anywhere', () => {
    vi.useFakeTimers();
    try {
      const fanout = new DeltaFanout(ANY_CHAT);
      const view = {} as never;
      const send = vi.fn();
      fanout.route(view, { type: 'agentText', text: 'x', messageId: 'm1', sessionId: 'ses_a' }, undefined, send);
      fanout.dispose(view);
      vi.advanceTimersByTime(100);
      expect(send).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('batching is per-VIEW: two views never share a buffer', () => {
    vi.useFakeTimers();
    try {
      const fanout = new DeltaFanout(ANY_CHAT);
      const viewA = {} as never;
      const viewB = {} as never;
      const sendA = vi.fn();
      const sendB = vi.fn();
      fanout.route(viewA, { type: 'agentText', text: 'a1', messageId: 'm1', sessionId: 'ses_a' }, undefined, sendA);
      fanout.route(viewB, { type: 'agentText', text: 'b1', messageId: 'm1', sessionId: 'ses_a' }, undefined, sendB);
      fanout.route(viewA, { type: 'agentText', text: 'a2', messageId: 'm1', sessionId: 'ses_a' }, undefined, sendA);

      vi.advanceTimersByTime(16);

      expect(sendA).toHaveBeenCalledTimes(1);
      expect(sendA).toHaveBeenCalledWith(expect.objectContaining({ text: 'a1a2' }));
      expect(sendB).toHaveBeenCalledTimes(1);
      expect(sendB).toHaveBeenCalledWith(expect.objectContaining({ text: 'b1' }));
    } finally {
      vi.useRealTimers();
    }
  });
});
