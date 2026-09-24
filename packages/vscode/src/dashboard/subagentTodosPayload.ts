// subagentTodosPayload.ts — t-qd2riw. Extracted out of subagentTodos.ts to
// keep that file under its architecture cap.
//
// THE bounded replacement for pulling a child's whole transcript just to find
// its last todowrite call: asks the engine's `subagent_todos` directly — a
// backward walk in bounded pages, server-side — instead of fetching the
// child's entire stored session to scan it here.
//
// Wraps the single hit (or none) as the same one-entry shape `toolEntry()`
// (subagentTranscript.ts) would have produced, so `todosFromTranscript`
// (subagentTodos.ts) needs no change at all: it still just finds the newest
// `todowrite` entry in the array handed to it, there is just at most one now.

import type { SessionMessage } from './sessionLog';

/** What `AcpClient.getSubagentTodos` needs to look like here — just enough to
 *  call it and read the result, not the whole client. */
interface TodosSource {
  getSubagentTodos(sessionId: string, cwd?: string): Promise<{ found: boolean; rawInput?: unknown }>;
}

/**
 * Swallows a read failure into an empty page, matching what
 * `subagentTranscriptPayload` did here before: this runs off a chunk handler,
 * behind `makeSubagentTodoPuller`'s own try/catch, and an empty page reads as
 * "nothing to show" rather than surfacing a raw engine error to a panel.
 */
export async function subagentTodosPayload(
  client: TodosSource | null | undefined,
  sessionId: string,
  cwd?: string,
): Promise<{ entries: SessionMessage[] }> {
  if (!sessionId || !client) return { entries: [] };
  try {
    const result = await client.getSubagentTodos(sessionId, cwd);
    if (!result?.found || result.rawInput === undefined) return { entries: [] };
    return {
      entries: [
        {
          kind: 'tool',
          text: 'todowrite',
          timestamp: 0,
          tool: { call: { toolCallId: 'subagent_todos', toolName: 'todowrite', rawInput: result.rawInput } },
        },
      ],
    };
  } catch {
    return { entries: [] };
  }
}
