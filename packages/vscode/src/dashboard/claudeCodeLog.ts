// claudeCodeLog.ts — a passthrough cell's REPLAY log: the same
// `Session.messageLog` an engine chat keeps, written from the translator's posts.
//
// FIXES: a passthrough turn posted straight to the webview and wrote nothing
// to the log, so closing and reopening the tab lost the conversation. A
// separate writer from sessionLog.ts, because the translator's field names
// differ (`content` vs `contentText`) and reusing that writer would log
// every Claude result as empty. Capped at 500 entries, oldest dropped, since
// a passthrough child can run far longer than an engine session's own context window.

import type { SessionMessage } from './sessionLog';
import { mirrorPost, type MirrorHost } from './claudeCodeMirror';

// Re-exported here rather than imported straight from the mirror by
// claudeCodeCell.ts, on the same convention claudeCodeCell uses for
// `answerPermission`: this file is already the funnel that owns the mirror
// wiring, and the cell only needs the one call that ends a binding.
export { resetMirror } from './claudeCodeMirror';

/** The host capabilities a logged post needs. Declared STRUCTURALLY rather
 *  than importing `ClaudeCodeHost`, so the value dependency runs one way:
 *  claudeCodeCell and claudeCodePermissions both import `emit` from here, and
 *  nothing here imports either of them. */
export interface LoggingHost extends MirrorHost {
  post(msg: Record<string, unknown>): void;
  replayLog?(sessionId: string): SessionMessage[] | undefined;
}

/** Post to the webview, write the cell's replay log, and feed the engine
 *  mirror — the three surfaces (live tab, reattached tab, History/Labyrinth)
 *  that must stay in sync for a Claude turn. */
export function emit(host: LoggingHost, sessionId: string, post: Record<string, unknown>): void {
  host.post(post);
  const log = host.replayLog?.(sessionId);
  if (log) logPassthroughPost(log, post);
  mirrorPost(host, sessionId, post);
}

/** Entries kept per bound cell. A tab reattach replays at most this many rows. */
export const PASSTHROUGH_LOG_CAP = 500;

/** Same ceiling sessionLog.ts puts on a tool result — beyond it nothing is
 *  renderable anyway, and the cards truncate again at 8000/2000 on draw. */
const CONTENT_CAP = 8000;

function str(v: unknown): string { return typeof v === 'string' ? v : ''; }

/** Trim to the cap, oldest first. In place, because the caller owns the array
 *  the panel replays from and a fresh array would orphan that reference. */
function trim(log: SessionMessage[]): void {
  if (log.length > PASSTHROUGH_LOG_CAP) log.splice(0, log.length - PASSTHROUGH_LOG_CAP);
}

/**
 * One translator post → zero or one log entries.
 *
 * Deliberately not a catch-all: only what a restore can actually rebuild is
 * kept. Live-only signalling (busy, turnDone, permission asks) is dropped, as
 * is `agentThought` — `SessionMessage.kind` has no 'thought' member, so
 * thinking cannot round-trip through this log; a passthrough restore losing
 * it is parity with the engine, not a regression.
 */
export function logPassthroughPost(log: SessionMessage[], post: Record<string, unknown>): void {
  const type = str(post.type);
  if (type === 'echoUser') {
        // The user's own line is logged from the ECHO, since the CLI's `user`
        // events carry tool results, never the user's text.
    const text = str(post.text);
    if (!text) return;
    log.push({ kind: 'user', text, timestamp: Date.now() });
    trim(log);
    return;
  }
  if (type === 'agentText') {
    const text = str(post.text);
    if (!text) return;
        // Text arrives as stream deltas; appending to the trailing agent row
        // turns them back into one paragraph instead of a column of fragments.
    const last = log[log.length - 1];
    if (last && last.kind === 'agent') { last.text += text; return; }
    log.push({ kind: 'agent', text, timestamp: Date.now() });
    trim(log);
    return;
  }
  if (type === 'system' || type === 'error') {
    const text = str(post.text) || str(post.message);
    if (!text) return;
    log.push({ kind: type === 'error' ? 'error' : 'system', text, timestamp: Date.now() });
    trim(log);
    return;
  }
  if (type === 'toolCall') {
    const title = str(post.title) || str(post.toolName) || '(tool call)';
    log.push({ kind: 'tool', text: title, timestamp: Date.now(), tool: { call: { ...post } } });
    trim(log);
    return;
  }
  if (type === 'toolResult') {
    const id = str(post.toolCallId);
    if (!id) return;
    for (let i = log.length - 1; i >= 0; i--) {
      const entry = log[i];
      if (entry.kind !== 'tool' || !entry.tool || entry.tool.call.toolCallId !== id) continue;
      entry.tool.result = { ...post, content: str(post.content).slice(0, CONTENT_CAP) };
      // The resolved title only lands on the update (a Write's title is the
      // file it wrote), so the entry's own text follows it — same as the live card.
      if (str(post.title)) entry.text = str(post.title);
      return;
    }
        // No matching call: the translator emits `toolResult` twice for one
        // tool, and the first can land before any `toolCall` if the opening
        // stream_event was dropped. Pushed as its own entry so the step isn't lost.
    log.push({ kind: 'tool', text: str(post.title) || str(post.toolName) || '(tool)', timestamp: Date.now(), tool: { call: { toolCallId: id, toolName: post.toolName, title: post.title }, result: { ...post, content: str(post.content).slice(0, CONTENT_CAP) } } });
    trim(log);
  }
}
