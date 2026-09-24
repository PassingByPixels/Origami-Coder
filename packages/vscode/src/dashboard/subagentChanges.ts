// subagentChanges.ts — t-j3qxbp: the parent chat's changed-files pill did not
// see a SUB-AGENT's edits at all. aggregateSessionChanges (webview,
// panes/sessionChanges.ts) only ever walked the parent's OWN message list,
// and a child's tool calls never reach that list — acp/event.ts degrades a
// forwarded child tool part to a tagged text line under the parent's session
// (`> edit: ...`), never a real toolCall/toolResult carrying a diff. Verified
// by reading acp/event.ts's `childToolLine` and chatToolMsg.ts's merge, which
// only sets `toolDiff` from a REAL toolResult.
//
// Same shape as subagentTodos.ts's fix for the identical problem with todos:
// the forwarded text line is a SIGNAL, not data, so on seeing one for an
// edit-class tool the host pulls that child's OWN stored session (the same
// `subagent_transcript` read the drawer's ↗ already uses) and hands the
// webview the child's raw before/after pairs. The webview already knows how
// to turn those into file/line counts — sessionChanges.ts's
// aggregateSessionChanges — so this file stays a thin, testable pull, not a
// second diff-counting implementation.

import type { SessionMessage } from './sessionLog';

/** Does this forwarded child chunk announce a tool that can carry a diff?
 *  Matches the same `> <tool>` / `> <tool>: <title>` shape subagentTodos.ts's
 *  `saysTodoWrite` matches (acp/event.ts's `childToolLine`), for the tool
 *  names ToolCard.ts's TOOLCARD_REGISTRY renders as an edit card. A future
 *  edit-class tool name needs adding here, the same limitation the todos
 *  signal already carries for `todowrite`. */
export function saysEditTool(text: string): boolean {
  return /^>\s*(edit|multi_edit|write|write_file|apply_patch)\b/im.test(text);
}

/** One file's raw before/after, as sessionChanges.ts's countDiffLines wants
 *  it. Not summed or deduped here — a child that touched one file twice
 *  contributes two entries, exactly how the parent's own message list would,
 *  so aggregateSessionChanges' existing per-path merge handles it the same
 *  way either way. */
export interface RawFileDiff { path: string; oldText: string; newText: string }

/** Every diff-bearing, non-failed tool entry in a child's transcript. Reads
 *  `entry.tool.result.diff`, the same field toolEntry() (subagentTranscript.ts)
 *  stamps from decodeToolContent — the identical shape a live toolResult's
 *  `diff` rider carries, so this is the same fact the parent's own pill would
 *  see if the child's tool calls had reached the parent's own message list. */
export function subagentFileDiffs(entries: readonly SessionMessage[]): RawFileDiff[] {
  const out: RawFileDiff[] = [];
  for (const entry of entries) {
    const result = entry.tool?.result as { status?: unknown; diff?: unknown } | undefined;
    if (!result || result.status === 'failed') continue;
    const d = result.diff as { path?: unknown; oldText?: unknown; newText?: unknown } | undefined;
    if (!d || typeof d !== 'object') continue;
    const path = typeof d.path === 'string' ? d.path : '';
    if (!path) continue;
    out.push({ path, oldText: String(d.oldText ?? ''), newText: String(d.newText ?? '') });
  }
  return out;
}

export interface SubagentChangesDeps {
  /** The child's stored session — `subagentTranscriptPayload`, already shaped. */
  read(childSessionId: string): Promise<{ entries: SessionMessage[] }>;
  /** Hand the child's raw diffs to the webview, keyed by child session id.
   *  Called even for an empty list, so a child whose only edit later failed
   *  can clear a stale pill contribution. */
  post(childSessionId: string, files: RawFileDiff[]): void;
  log?(line: string): void;
}

/** Same "at most one read per child in flight" coalescing rule as
 *  makeSubagentTodoPuller: a child mid-edit-spree can fire several signals
 *  in a few seconds, and each read is a whole transcript. */
export function makeSubagentChangesPuller(deps: SubagentChangesDeps): (childSessionId: string) => void {
  const inFlight = new Set<string>();
  const again = new Set<string>();

  async function run(child: string): Promise<void> {
    inFlight.add(child);
    try {
      deps.post(child, subagentFileDiffs((await deps.read(child)).entries));
    } catch (e) {
      deps.log?.(`[subagent-changes] ${child}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      inFlight.delete(child);
    }
    if (!again.delete(child)) return;
    await run(child);
  }

  return (childSessionId: string) => {
    if (!childSessionId) return;
    if (inFlight.has(childSessionId)) {
      again.add(childSessionId);
      return;
    }
    void run(childSessionId);
  };
}
