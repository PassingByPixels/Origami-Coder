// subagentTranscript.ts — a sub-agent's stored session, shaped into the chat's own replay-log
// entries so the webview draws it with the live renderer (ChatTranscript.svelte) instead of a
// lookalike that drifts.
// Uses `SessionMessage` because it's already the wire form a reloaded chat is rebuilt from
// (chatRestore.ts -> applyToolCall/applyToolResult) — emitting anything else would be a second
// mapper free to disagree with the first. Field readers are the live path's own
// (acpToolContent/acpToolMeta/acpTaskMeta), not re-derived.
import type { SubagentEntry, SubagentTranscriptResult } from '../acpExtTypes';
import type { SessionMessage } from './sessionLog';
import { decodeToolContent } from '../acpToolContent';
import { toolNameRider } from '../acpToolMeta';
import { taskRiders } from '../acpTaskMeta';

interface TranscriptSource {
  getSubagentTranscript(
    sessionId: string,
    cwd?: string,
    page?: { limit?: number; before?: string },
  ): Promise<SubagentTranscriptResult>;
}

/** t-krxap7. One page of a child's transcript: how many messages, and where to
 *  start. `before` is an opaque cursor from a previous payload's `cursor`. */
export interface TranscriptPage {
  limit?: number;
  before?: string;
}

export interface SubagentTranscriptPayload {
  sessionId: string;
  found: boolean;
  running: boolean;
  truncated: boolean;
  entries: SessionMessage[];
  error?: string;
  /** t-krxap7. Echoed back so the panel can tell which block this answers: a
   *  reply with no `before` is the newest page (open, refresh, poll), one with a
   *  `before` is an earlier block to PREPEND. Without the echo a reply that
   *  crossed with another would be applied to the wrong end of the window. */
  before?: string;
  /** Older messages exist before this page. Always false on an unpaged read. */
  hasMore: boolean;
  /** The cursor for the block before this one; absent at the head. */
  cursor?: string;
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

/** One settled `ToolCall` as the CALL/RESULT pair the card rules expect — split to mirror what the
 *  live wire delivers, so the restored card is byte-identical to the live one. */
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
    // 0 = unknown; the engine's TranscriptEntry carries no timestamp. chatRestore.ts only overrides
    // when truthy, so the card keeps its rebuild-time Date.now() stamp — still wrong, but
    // ToolCard's read-only gate drops the "elapsed"/"running" strips entirely since a finished
    // sub-agent's card has no present tense. A real fix would need the engine to carry start+end
    // and the card to show end-minus-start.
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

/** One projected entry as one replay-log row. An `error` entry is the turn whose model call failed
 *  and must stay visible — dropping it turns a rate-limited child into one that finished silently.
 */
export function transcriptEntry(entry: SubagentEntry): SessionMessage {
  if (entry.type === 'tool') return toolEntry(entry);
  if (entry.type === 'error') {
    return { kind: 'error', text: `${entry.name}: ${entry.message}`, timestamp: 0 };
  }
  // t-gvz8t0. `thought` is the live chat's OWN reasoning row, so ChatTranscript
  // draws it through the same ThoughtPill the main chat uses — never as prose,
  // and never as the child's reply.
  if (entry.type === 'reasoning') return { kind: 'thought', text: entry.text, timestamp: 0 };
  return { kind: entry.role === 'user' ? 'user' : 'agent', text: entry.text, timestamp: 0 };
}

/**
 * A child's transcript, ready to post to the webview. A read FAILURE and a
 * child that is GONE are different on purpose: `found:false` means the
 * engine cannot read it (draws "no transcript"); `error` means the call
 * itself failed (no engine/connection), which the user can act on.
 */
export async function subagentTranscriptPayload(
  client: TranscriptSource | null | undefined,
  sessionId: string,
  /** The child's own directory. Blank = let the engine resolve it, the same
   *  contract runStepsPayload documents for a run. */
  cwd = '',
  /** Absent, or a zero/negative limit, means the whole transcript — the read the
   *  sub-agent todo scan still makes. */
  page?: TranscriptPage,
): Promise<SubagentTranscriptPayload> {
  const empty = {
    sessionId,
    found: false,
    running: false,
    truncated: false,
    entries: [],
    hasMore: false,
    ...(page?.before ? { before: page.before } : {}),
  };
  if (!sessionId) return { ...empty, error: 'No sub-agent was selected.' };
  if (!client) return { ...empty, error: NO_SESSION };
  try {
    const res = await client.getSubagentTranscript(sessionId, cwd || undefined, page);
    const entries = Array.isArray(res?.entries) ? res.entries : [];
    return {
      sessionId,
      found: res?.found === true,
      running: res?.running === true,
      truncated: res?.truncated === true,
      entries: entries.map(transcriptEntry),
      // A cursor is what makes another page REACHABLE, so "more exists" without
      // one is reported as the head: offering a button that cannot fetch is worse
      // than stopping one block early.
      hasMore: res?.hasMore === true && typeof res.cursor === 'string' && res.cursor.length > 0,
      ...(typeof res?.cursor === 'string' && res.cursor ? { cursor: res.cursor } : {}),
      ...(page?.before ? { before: page.before } : {}),
    };
  } catch (e) {
    return { ...empty, error: message(e) };
  }
}
