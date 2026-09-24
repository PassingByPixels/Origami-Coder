import type * as vscode from 'vscode';

/**
 * t-tc2rlo #9. The message types a streaming turn posts once PER MODEL CHUNK —
 * hundreds per turn, per attached view. Anything else (toolCall, sessionClosed,
 * a whole-part update, ...) is a state change, not a chunk, and is never batched:
 * batching it would delay the state it carries behind an arbitrary frame boundary.
 */
const DELTA_TYPES = new Set(['agentText', 'agentThought', 'subagentChunk', 'subagentThinking']);

/** One requestAnimationFrame-ish window. VS Code's webview host has no rAF on
 *  the extension side, so this is a plain timer at the same cadence. */
const FRAME_MS = 16;

type Delta = Record<string, unknown> & { type: string; text: string };

function deltaKey(msg: Record<string, unknown>): string | undefined {
  const type = msg.type;
  if (typeof type !== 'string' || !DELTA_TYPES.has(type) || typeof msg.text !== 'string') return undefined;
  const sessionId = typeof msg.sessionId === 'string' ? msg.sessionId : '';
  const childSessionId = typeof msg.childSessionId === 'string' ? msg.childSessionId : '';
  const messageId = typeof msg.messageId === 'string' ? msg.messageId : '';
  // NUL-separated: none of these ids can contain it, and a plain join risks a
  // collision between e.g. sessionId "a-b" + childSessionId "" and sessionId "a" + childSessionId "b-".
  return [type, sessionId, childSessionId, messageId].join('\u0000');
}

type Pending = { msg: Delta; send: (msg: Record<string, unknown>) => void; timer: ReturnType<typeof setTimeout> };

/**
 * Per-webview delta coalescing and session filtering for `DashboardPanel.post()`
 * (t-tc2rlo #9). Two independent things, one seam:
 *
 * 1. FILTER: `route()` never sends a per-session message to a view whose
 *    `viewSolo` points at a DIFFERENT open chat — a popped-out chat tab used to
 *    receive (and silently ignore) every other chat's traffic too. A `sessionId`
 *    that names no open chat is not another chat's traffic: it is a reply keyed
 *    on some other id (t-tydjkm: `subagentTranscriptData` carries the CHILD's
 *    id), and dropping it left the asking panel waiting for ever.
 * 2. BATCH: same-key streaming deltas (same type/session/child/message) arriving
 *    within one `FRAME_MS` window are concatenated into ONE post instead of one
 *    per model chunk. Any other message flushes that view's pending deltas FIRST,
 *    so relative order — delta burst, then the state change that followed it —
 *    is exactly what an unbatched stream would have produced.
 */
export class DeltaFanout {
  private readonly pending = new Map<vscode.Webview, Map<string, Pending>>();

  /** `isChat(id)`: is `id` an open chat's session id (DashboardPanel's `sessions`)?
   *  Required, so no caller can fall back to "every id is a chat". */
  constructor(private readonly isChat: (sessionId: string) => boolean) {}

  /**
   * Route one message to one view. `soloSessionId` is `viewSolo.get(view)` —
   * undefined for the primary/unsolo'd host, which always sees every session.
   * `send` performs the actual `postMessage` (per-view image resolution lives
   * in the caller, not here).
   */
  route(
    view: vscode.Webview,
    msg: Record<string, unknown>,
    soloSessionId: string | undefined,
    send: (msg: Record<string, unknown>) => void,
  ): void {
    const sid = msg.sessionId;
    if (soloSessionId !== undefined && typeof sid === 'string' && sid !== soloSessionId && this.isChat(sid)) return;
    const key = deltaKey(msg);
    if (key === undefined) {
      this.flush(view, send);
      send(msg);
      return;
    }
    const byView = this.pending.get(view) ?? new Map<string, Pending>();
    this.pending.set(view, byView);
    const existing = byView.get(key);
    if (existing) {
      existing.msg = { ...(msg as Delta), text: existing.msg.text + (msg as Delta).text };
      return;
    }
    const entry: Pending = {
      msg: msg as Delta,
      send,
      timer: setTimeout(() => {
        byView.delete(key);
        entry.send(entry.msg);
      }, FRAME_MS),
    };
    byView.set(key, entry);
  }

  /** Send every buffered delta for one view now, in the order each key was
   *  first seen in this batch window (Map preserves insertion order). Used
   *  both to keep ordering before a non-delta message and to drain a view
   *  that is going away. */
  flush(view: vscode.Webview, send?: (msg: Record<string, unknown>) => void): void {
    const byView = this.pending.get(view);
    if (!byView || byView.size === 0) return;
    const entries = [...byView.values()];
    byView.clear();
    for (const entry of entries) {
      clearTimeout(entry.timer);
      (send ?? entry.send)(entry.msg);
    }
  }

  /** A view was torn down: drop its pending state without a final send — the
   *  webview is gone, so there is nothing left to deliver to (t-tc2rlo, see
   *  finding #12 on maps that are never evicted; this one is). */
  dispose(view: vscode.Webview): void {
    const byView = this.pending.get(view);
    if (byView) for (const entry of byView.values()) clearTimeout(entry.timer);
    this.pending.delete(view);
  }
}
