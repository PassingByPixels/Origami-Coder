// The tools pane's session-length cache of subagent cells confirmed written but not yet visible to
// the engine (t-dkk5jd), PROJECTED onto a freshly-read catalog. The store itself moved to
// subagentOverrideMask.ts when the reset gained a memory (t-fiszlv R13); this file is what it was
// always described as — pure payload shaping, no config I/O at all.
//
// WHY IT EXISTS: the engine only re-reads origami.json at its next spawn, so a fresh `listTools()`
// answers with whatever it cached at the LAST spawn — every cell changed since then is invisible to
// it, not just the previous one. A single-cell patch onto that stale read was the bug: each click
// re-reads the catalog fresh, and the webview replaces its whole `subagents` array on every
// `toolsData` message (ToolsPane.svelte's `window.addEventListener('message', ...)`), so patching
// only the CURRENT cell into that read dropped every cell patched before it.

import { maskedCells } from './subagentOverrideMask';
import type { ToolState } from './toolDeferConfig';

export {
  recordSubagentOverride,
  resetSubagentOverrides,
  __resetPendingSubagentOverridesForTests,
} from './subagentOverrideMask';

/** Patch ONE cell into a freshly-read catalog — the running engine's CACHED verdict still needs a
 *  reload, so a re-read alone would show the old state. Pure and testable with no map involved;
 *  `applyPendingSubagentOverrides` below folds over it for every cell recorded this session. */
export function patchSubagentStatePayload(
  payload: Record<string, unknown>,
  agent: string,
  id: string,
  state: ToolState,
): Record<string, unknown> {
  const rows = payload['subagents'];
  if (!Array.isArray(rows)) return payload;
  return {
    ...payload,
    subagents: rows.map((row) => {
      if (!row || typeof row !== 'object' || (row as { agent?: unknown }).agent !== agent) return row;
      const raw = (row as { states?: unknown }).states;
      const states = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
      return { ...row, states: { ...states, [id]: state } };
    }),
  };
}

/** Patch EVERY cell confirmed this session into a freshly-read catalog — not just the most recent
 *  one. Call this at the POST boundary only (toolsCatalog.ts's `postCatalog`) — never on a read a
 *  write is about to make a `current`-state decision from, or that write would see its own prior
 *  override reflected back as if the engine had confirmed it (toolsPane.ts's `setSubagentState`,
 *  and `catalogPayload`'s own comment, explain why). */
export function applyPendingSubagentOverrides(payload: Record<string, unknown>): Record<string, unknown> {
  let next = payload;
  for (const [agent, id, state] of maskedCells()) next = patchSubagentStatePayload(next, agent, id, state);
  return next;
}
