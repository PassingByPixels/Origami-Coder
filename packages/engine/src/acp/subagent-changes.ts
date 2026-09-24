import type { TranscriptEntry } from "./subagent-transcript"

/**
 * t-ru0by6 (same family as t-qd2riw's subagent-todos.ts). THE bounded
 * replacement for pulling a child's whole transcript just to find its
 * diff-bearing tool parts — used by the `subagent_changes` ext method's
 * backward page walk (acp/service.ts).
 *
 * `subagentChanges.ts` (host) used to pull a CHILD's entire stored session —
 * via `subagent_transcript` with no `limit` — every time it saw a forwarded
 * `> edit`/`> write`/... signal, just to scan it for diff-bearing tool
 * results. This moves the scan server-side and bounds it the same way
 * subagent-todos.ts bounds the todowrite scan: never more than one page of
 * stored messages per store round trip.
 */

export type RawFileDiff = { readonly path: string; readonly oldText: string; readonly newText: string }

/**
 * Every diff-bearing, non-failed tool entry in this page, NEWEST first — the
 * page itself is oldest-first (subagent-transcript.ts's `project` preserves
 * store order), so this walks it backward. A tool without diff content (a
 * read, a grep) or a failed call (nothing actually changed) contributes
 * nothing, matching the host's own `subagentFileDiffs` filter exactly.
 */
export function diffBearingParts(entries: readonly TranscriptEntry[]): RawFileDiff[] {
  const out: RawFileDiff[] = []
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]
    if (!entry || entry.type !== "tool") continue
    const call = entry.toolCall
    if (call.status === "failed") continue
    const diff = call.content?.find((item): item is Extract<(typeof call.content)[number], { type: "diff" }> =>
      item?.type === "diff",
    )
    if (!diff) continue
    const path = typeof diff.path === "string" ? diff.path : ""
    if (!path) continue
    out.push({ path, oldText: diff.oldText ?? "", newText: diff.newText })
  }
  return out
}

export * as SubagentChanges from "./subagent-changes"
