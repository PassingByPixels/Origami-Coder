// subagentTranscript.ts — a sub-agent's stored session, shaped into the chat's
// own REPLAY-LOG entries so the webview can draw it with the renderer the live
// chat uses (ChatTranscript.svelte) instead of a lookalike that drifts.
//
// WHY THIS SHAPE AND NOT A NEW ONE. `SessionMessage` (sessionLog.ts) is already
// the wire form a chat is rebuilt from after a reload: the webview's
// chatRestore.ts feeds it straight through applyToolCall/applyToolResult, the
// same merge rules the live stream runs. Emitting anything else would mean a
// second mapper into `Message`, free to disagree with the first — and the
// disagreement would show up as a sub-agent card that renders differently from
// the identical card three lines up in the parent's transcript.
//
// The per-field readers are the LIVE PATH's own (acpToolContent /
// acpToolMeta / acpTaskMeta), not re-derived here. A settled `ToolCall`
// carries what a `tool_call` and its `tool_call_update` carried between them,
// so both payloads are built from the one object.
//
// No `vscode` import, so every decision here is testable without an extension
// host — the same rule boardData.ts follows.
import type { SubagentEntry, SubagentTranscriptResult } from '../acpExtTypes';
import type { SessionMessage } from './sessionLog';
import { decodeToolContent } from '../acpToolContent';
import { toolNameRider } from '../acpToolMeta';
import { taskRiders } from '../acpTaskMeta';

interface TranscriptSource {
  getSubagentTranscript(sessionId: string, cwd?: string): Promise<SubagentTranscriptResult>;
}

export interface SubagentTranscriptPayload {
  sessionId: string;
  found: boolean;
  running: boolean;
  truncated: boolean;
  entries: SessionMessage[];
  error?: string;
}

const NO_SESSION = 'Open a chat first — this needs a live engine connection.';
const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** First ACP location, the same read acpClient makes for a live card — it is
 *  what lets `write` say WHERE it wrote instead of just "write". */
function firstPath(call: Record<string, unknown>): string | undefined {
  const locs = call.locations;
  if (!Array.isArray(locs)) return undefined;
  const p = (locs[0] as { path?: unknown } | undefined)?.path;
  return typeof p === 'string' ? p : undefined;
}

/**
 * One settled `ToolCall` as the CALL/RESULT pair the card rules expect.
 *
 * The split mirrors what the live wire delivers rather than dumping the whole
 * object into both halves: the pending frame carries kind/title/rawInput, the
 * terminal frame carries the resolved title, the path, the content and the
 * output metadata. Running it through the same two functions is what makes the
 * restored card byte-identical to the live one.
 */
function toolEntry(entry: Extract<SubagentEntry, { type: 'tool' }>): SessionMessage {
  const call = entry.toolCall ?? {};
  const status = typeof call.status === 'string' ? call.status : 'completed';
  const title = typeof call.title === 'string' ? call.title : '';
  const path = firstPath(call);
  const riders = taskRiders(call);
  const { contentText, diff, images } = decodeToolContent(call.content);
  return {
    kind: 'tool',
    text: title,
    // 0 = UNKNOWN. The engine's TranscriptEntry carries no time, so there is
    // nothing honest to put here.
    //
    // Be clear about what 0 does and does NOT buy: chatRestore.ts only
    // overrides when truthy (`if (card && entry.timestamp)`), so the card keeps
    // the `Date.now()` that applyToolCall stamped when it was REBUILT. The
    // stamp is therefore still wrong — it says "just now" for a command that
    // ran an hour ago. What stops that surfacing is the READ-ONLY gate in
    // ToolCard, which drops the "Ns elapsed" and "running for a while" strips
    // entirely, because both are claims about the present tense and a finished
    // sub-agent's card has no present tense.
    //
    // The real fix, if a per-command duration is ever wanted here, is for the
    // engine to carry start AND end (run-steps.ts already has a `timing()`
    // helper reading them off the same stored messages) and for the card to
    // show end-minus-start rather than now-minus-start.
    timestamp: 0,
    tool: {
      call: {
        toolCallId: call.toolCallId,
        title,
        kind: call.kind ?? 'other',
        status,
        toolName: toolNameRider(call),
        path,
        rawInput: call.rawInput,
        ...riders,
      },
      result: {
        toolCallId: call.toolCallId,
        status,
        content: contentText ?? '',
        diff,
        images,
        title,
        path,
        toolName: toolNameRider(call),
        rawInput: call.rawInput,
        rawOutputMeta: (call.rawOutput as { metadata?: unknown } | undefined)?.metadata,
        ...riders,
      },
    },
  };
}

/** One projected entry as one replay-log row. A `text` entry's role picks the
 *  side of the chat it lands on; an `error` entry is the turn whose MODEL CALL
 *  failed, and it must stay visible — dropping it turns a child that died to a
 *  rate limit into one that finished and said nothing. */
export function transcriptEntry(entry: SubagentEntry): SessionMessage {
  if (entry.type === 'tool') return toolEntry(entry);
  if (entry.type === 'error') {
    return { kind: 'error', text: `${entry.name}: ${entry.message}`, timestamp: 0 };
  }
  return { kind: entry.role === 'user' ? 'user' : 'agent', text: entry.text, timestamp: 0 };
}

/**
 * A child's transcript, ready to post to the webview.
 *
 * A read FAILURE and a child that is GONE are different results on purpose.
 * `found: false` is the engine's own answer for a session it cannot read, and
 * the panel draws "no transcript" for it. `error` is set only when the call
 * itself failed — no engine, no connection — which is a condition the user can
 * act on. Collapsing the two would tell someone to reconnect when the real
 * answer is that the child was cleaned up an hour ago.
 */
export async function subagentTranscriptPayload(
  client: TranscriptSource | null | undefined,
  sessionId: string,
  /** The child's own directory. Blank = let the engine resolve it, the same
   *  contract runStepsPayload documents for a run. */
  cwd = '',
): Promise<SubagentTranscriptPayload> {
  const empty = { sessionId, found: false, running: false, truncated: false, entries: [] };
  if (!sessionId) return { ...empty, error: 'No sub-agent was selected.' };
  if (!client) return { ...empty, error: NO_SESSION };
  try {
    const res = await client.getSubagentTranscript(sessionId, cwd || undefined);
    const entries = Array.isArray(res?.entries) ? res.entries : [];
    return {
      sessionId,
      found: res?.found === true,
      running: res?.running === true,
      truncated: res?.truncated === true,
      entries: entries.map(transcriptEntry),
    };
  } catch (e) {
    return { ...empty, error: message(e) };
  }
}
