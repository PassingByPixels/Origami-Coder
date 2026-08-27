// sessionLog.ts — the shape of a chat's replay log (`Session.messageLog`) and
// the rules for writing TOOL entries into it. EXTRACTED from DashboardPanel.ts,
// which sat EXACTLY on its architecture cap, when a reloaded chat had to start
// restoring tool CARDS instead of plain text rows.
//
// Why the log has to carry the whole payload: a recalled chat's editor tab is
// opened AFTER `start()` (see DashboardPanel.createSession), so every live
// `toolCall`/`toolResult` post made while the engine replays the transcript
// lands on a webview that does not exist yet. The tab is caught up from THIS
// log instead (replaySessionsTo -> `restoreMessages`). A title-only entry —
// all the log used to keep — cannot rebuild a card, so the restore had no
// choice but to render the tool step as text. The engine's replay was never at
// fault: it re-emits `tool_call` + `tool_call_update` with the
// `_meta.origami_tool_name` rider on every reload.

/** The two live handler payloads a tool card is built from, kept verbatim so a
 *  restore can run the SAME merge rules as the live stream (chatToolMsg.ts).
 *  `call` is what the webview receives as `toolCall`; `result` as `toolResult`. */
export interface ToolLogCard {
  call: Record<string, unknown>;
  result?: Record<string, unknown>;
}

export interface SessionMessage {
  kind: 'user' | 'agent' | 'system' | 'tool' | 'error';
  text: string;
  timestamp: number;
  /** Present on 'tool' entries written since the reload fix. Absent on an
   *  archived log written before it, which still restores as a text row. */
  tool?: ToolLogCard;
}

/** A tool result's output is the only unbounded field on either payload, and
 *  this log is written to disk for non-engine sessions. The card truncates to
 *  8000 for bash/chart and 2000 otherwise, so nothing beyond this is renderable. */
const CONTENT_CAP = 8000;

/** `tool_call`: append the card entry. Returns the title the caller reports to
 *  the Folds board, so that read stays in one place. */
export function logToolCall(log: SessionMessage[], args: Record<string, unknown>): string {
  const title = typeof args.title === 'string' && args.title ? args.title : '(tool call)';
  log.push({ kind: 'tool', text: title, timestamp: Date.now(), tool: { call: { ...args } } });
  return title;
}

/** `tool_call_update`: merge the update onto its OWN entry, by toolCallId.
 *  `contentText` is renamed to `content` here because that is the field name
 *  the webview's `toolResult` message carries and the card rules read.
 *
 *  An update with no matching entry is DROPPED. The only way to get one is a
 *  call this log never saw (todowrite is absorbed before it reaches here), and
 *  a detached result row would restore as a card with no call above it. */
export function logToolResult(log: SessionMessage[], args: Record<string, unknown>): void {
  const id = args.toolCallId;
  if (typeof id !== 'string' || !id) return;
  for (let i = log.length - 1; i >= 0; i--) {
    const entry = log[i];
    if (entry.kind !== 'tool' || !entry.tool || entry.tool.call.toolCallId !== id) continue;
    const text = typeof args.contentText === 'string' ? args.contentText : '';
    entry.tool.result = { ...args, content: text.slice(0, CONTENT_CAP) };
    // The resolved title (write's is the file it wrote) only lands on the
    // update, so the entry's own text follows it — same as the live card.
    if (typeof args.title === 'string' && args.title) entry.text = args.title;
    return;
  }
}

/** `subagentDone`: stamp a BACKGROUND child's terminal marker onto its own card.
 *
 *  The marker arrives on its own channel, not as a `tool_call_update`, so
 *  neither writer above sees it — and the drawer retires a background row on
 *  this field ALONE (subagentEntry.ts `stillOut`). Leaving it unlogged made the
 *  fact live-only, so every reload replayed a card with no `taskDone` and
 *  resurrected a long-dead sub-agent as permanently "running".
 *
 *  Onto `result`, because that is the payload the restore replays through
 *  `applyToolResult`, whose merge rules already know the field. `endedAt` rides
 *  along for the same reason: a DETACHED child's launcher card ended back at
 *  spawn, so this marker carries the only honest end it has, and without it a
 *  restored row prints an age off the wall clock instead of its real total. */
export function logSubagentDone(log: SessionMessage[], taskSessionId: string, state: string, endedAt?: number): void {
  if (!taskSessionId) return;
  const done = state === 'error' ? 'error' : 'completed';
  const ended = endedAt === undefined ? {} : { taskEndedAt: endedAt };
  for (let i = log.length - 1; i >= 0; i--) {
    const entry = log[i];
    if (entry.kind !== 'tool' || !entry.tool) continue;
    const id = entry.tool.call.taskSessionId ?? entry.tool.result?.taskSessionId;
    if (id !== taskSessionId) continue;
    entry.tool.result = { ...entry.tool.result, taskSessionId, taskDone: done, ...ended };
    return;
  }
}

/**
 * The log as it goes to the DISK archive (`sessions/<id>.json`), with the
 * `browser` tool's screenshots dropped. They are `data:` URIs — hundreds of KB
 * each — and an archive is re-read whole by the history pane, so keeping them
 * would trade a text-row bug for a multi-megabyte file per chat.
 *
 * Nothing is lost on the path this fix is FOR: an engine-backed chat is never
 * archived at all (saveSession skips it), and its images come back on the next
 * `session/load` because the engine re-sends them with the completed frame.
 */
export function archiveLog(log: readonly SessionMessage[]): SessionMessage[] {
  return log.map((entry) => {
    if (!entry.tool?.result || !('images' in entry.tool.result)) return entry;
    const { images: _dropped, ...rest } = entry.tool.result;
    return { ...entry, tool: { call: entry.tool.call, result: rest } };
  });
}
