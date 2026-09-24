// sessionLog.ts — the shape of a chat's replay log (`Session.messageLog`) and the rules for writing
// TOOL entries into it.
// A recalled chat's tab is opened AFTER start(), so live toolCall/toolResult posts made during
// replay never reach it — the tab is instead caught up from this log (replaySessionsTo ->
// restoreMessages). The log must carry the whole payload, or a restore can only render the step as
// text.

import type { PeerOrigin } from './peerMessages';
import { betterStoredTitle, trimRawInput } from './sessionLogTitle';
import type { StreamDropNotice } from '../acpStreamDrop';

/** The two live handler payloads a tool card is built from, so a restore runs the same merge rules
 *  as the live stream. */
export interface ToolLogCard {
  call: Record<string, unknown>;
  result?: Record<string, unknown>;
}

export interface SessionMessage {
  /** `thought` is projection-only (subagentTranscript.ts): a sub-agent's stored
   *  reasoning, drawn by the chat's own ThoughtPill. Nothing WRITES one to a
   *  session log — reasoning is not logged, live or restored. */
  kind: 'user' | 'agent' | 'system' | 'tool' | 'error' | 'peer' | 'thought' | 'streamDrop';
  text: string;
  timestamp: number;
  /** Present on 'tool' entries written since the reload fix. Absent on an
   *  archived log written before it, which still restores as a text row. */
  tool?: ToolLogCard;
  /** Present on 'peer' entries (t-d94ywq) — the rider `webview/dashboard/panes/restoredRow.ts`
   *  needs to rebuild the same PeerMessageRow the live stream showed. */
  peer?: PeerOrigin;
  /** Present on 'streamDrop' entries (t-q90gj9) — the notice the alert card is
   *  drawn from. Without it a reloaded window would restore the card as a text
   *  row, which is exactly the defect the structured notice replaced. */
  streamDrop?: StreamDropNotice;
  /** t-ucnp7t: the engine message id of an 'agent' entry built from an OLDER page, its rewind anchor. */
  messageId?: string;
}

// The stream-drop write lives in sessionLogStreamDrop.ts (this file was at its 115-line cap
// when two lanes landed on it at once); it appends or collapses a notice entry.
export { logStreamDrop } from './sessionLogStreamDrop';

/** A tool result's output is the only unbounded field; caps to 8000 for bash/chart, 2000 otherwise,
 *  so nothing beyond this is renderable. */
const CONTENT_CAP = 8000;

/** `tool_call`: append the card entry. Returns the title the caller reports to
 *  the Folds board, so that read stays in one place. */
export function logToolCall(log: SessionMessage[], args: Record<string, unknown>): string {
  const title = typeof args.title === 'string' && args.title ? args.title : '(tool call)';
  log.push({ kind: 'tool', text: title, timestamp: Date.now(), tool: { call: { ...args } } });
  return title;
}

/** `tool_call_update`: merge the update onto its own entry, by toolCallId. `contentText` is renamed
 *  to `content` to match the webview's `toolResult` field. An update with no matching entry is
 *  dropped.
 *
 *  t-q90p6v — why this MERGES instead of replacing, and why it writes back onto `call`: a card's
 *  identity arrives spread across frames. The PENDING frame has the bare tool name and a partial
 *  input (bash carried only `{cwd}`); the RUNNING frame carries the real title and the rawInput the
 *  shell card is drawn from; the COMPLETED frame carries the resolved title but NO rawInput
 *  (acp/tool.ts completedToolUpdate). Replacing the stored result with the last frame therefore
 *  threw the rawInput away, and the stored call kept the placeholder title — so a reopened session
 *  showed `bash`, `Edit: edit`, `read` where the live card showed the command and the path. The
 *  entry now keeps the best title and the widest rawInput it has seen. */
export function logToolResult(log: SessionMessage[], args: Record<string, unknown>): void {
  const id = args.toolCallId;
  if (typeof id !== 'string' || !id) return;
  for (let i = log.length - 1; i >= 0; i--) {
    const entry = log[i];
    if (entry.kind !== 'tool' || !entry.tool || entry.tool.call.toolCallId !== id) continue;
    const text = typeof args.contentText === 'string' ? args.contentText : '';
    const previous = entry.tool.result;
    const merged: Record<string, unknown> = { ...previous, ...args, content: text.slice(0, CONTENT_CAP) };
    // Write-if-present, like the webview's own riders: a later frame that carries no rawInput must
    // not blank the one an earlier frame established.
    const raw = trimRawInput(args.rawInput) ?? previous?.rawInput;
    if (raw !== undefined) merged.rawInput = raw; else delete merged.rawInput;
    entry.tool.result = merged;
    // The resolved title (write's is the file it wrote) only lands on the
    // update, so the entry's own text follows it — same as the live card.
    if (typeof args.title === 'string' && args.title) entry.text = args.title;
    // …and the stored CALL adopts it, because a restore builds the card's label from the call.
    const better = betterStoredTitle(entry.tool.call, args.title);
    if (better) entry.tool.call.title = better;
    const callRaw = trimRawInput(args.rawInput);
    if (callRaw && Object.keys(callRaw as Record<string, unknown>).length) entry.tool.call.rawInput = callRaw;
    return;
  }
}

// The two SUB-AGENT writes live in sessionLogSubagent.ts (this file was at
// 92/115 when the token stamp landed): they write the same log, but by CHILD
// SESSION rather than by tool-call id, and neither appends an entry.
export { logSubagentDone, logSubagentTokens } from './sessionLogSubagent';

/**
 * The log as it goes to the disk archive, with the `browser` tool's
 * screenshots dropped — they are hundreds-of-KB data: URIs and the archive is
 * re-read whole by the history pane. Nothing is lost for an engine-backed
 * chat: it is never archived, and images return on the next session/load.
 */
export function archiveLog(log: readonly SessionMessage[]): SessionMessage[] {
  return log.map((entry) => {
    if (!entry.tool?.result || !('images' in entry.tool.result)) return entry;
    const { images: _dropped, ...rest } = entry.tool.result;
    return { ...entry, tool: { call: entry.tool.call, result: rest } };
  });
}
