// subagentChangesPayload.ts — t-ru0by6. Extracted the same way
// subagentTodosPayload.ts was extracted from subagentTodos.ts (t-qd2riw): the
// bounded replacement for pulling a child's whole transcript just to find its
// diff-bearing tool parts — asks the engine's `subagent_changes` directly — a
// backward walk in bounded pages, server-side — instead of fetching the
// child's entire stored session to scan it here.
//
// Wraps each diff as the same one-entry-per-diff `SessionMessage` shape
// `toolEntry()` (subagentTranscript.ts) would have produced for a completed
// edit-class tool call, so `subagentFileDiffs` (subagentChanges.ts) needs no
// change at all: it still just filters completed-tool entries carrying a
// `diff`, there is just no whole-transcript read behind them any more.

import type { SessionMessage } from './sessionLog';

/** What `AcpClient.getSubagentChanges` needs to look like here — just enough
 *  to call it and read the result, not the whole client. */
interface ChangesSource {
  getSubagentChanges(
    sessionId: string,
    cwd?: string,
  ): Promise<{ found: boolean; diffs: Array<{ path: string; oldText: string; newText: string }> }>;
}

/**
 * Swallows a read failure into an empty page, matching what
 * `subagentTranscriptPayload` did here before: this runs off a chunk handler,
 * behind `makeSubagentChangesPuller`'s own try/catch, and an empty page reads
 * as "nothing to show" rather than surfacing a raw engine error to a panel.
 */
export async function subagentChangesPayload(
  client: ChangesSource | null | undefined,
  sessionId: string,
  cwd?: string,
): Promise<{ entries: SessionMessage[] }> {
  if (!sessionId || !client) return { entries: [] };
  try {
    const result = await client.getSubagentChanges(sessionId, cwd);
    if (!result?.found || !Array.isArray(result.diffs)) return { entries: [] };
    return {
      entries: result.diffs.map((diff, i) => ({
        kind: 'tool',
        text: 'edit',
        timestamp: 0,
        tool: {
          call: { toolCallId: `subagent_changes_${i}`, toolName: 'edit' },
          result: { toolCallId: `subagent_changes_${i}`, status: 'completed', diff },
        },
      })),
    };
  } catch {
    return { entries: [] };
  }
}
