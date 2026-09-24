// What a reset cell SHOWS until the engine re-reads (t-fiszlv R13).
//
// THE STALENESS IS ONE-SIDED, and that is what makes this answerable. The
// engine's sub-agent matrix is built from two reads (packages/engine, acp/tools.ts
// `listTools`): the CONFIG, read live on every call, and the AGENT REGISTRY, a
// snapshot rebuilt only on a rescan. `agent.<name>.tool_search` comes off the
// live config, so a reset of those keys is already visible in the very next
// answer. `agent.<name>.permission` is merged into the registry's ruleset, so a
// removed rule keeps voting until the window reload — which is why the ledger
// redrew, as the engine's own truth, the overrides the click had just deleted.
//
// So only the removed PERMISSION rules need an answer here:
//
//   `allow` -> `off`. Exact: writeSubagentToolState writes an allow ONLY when
//   the cell is already off, so the thing it was beating is a deny that is not
//   in this file. Take the allow away and the cell is off again.
//
//   `deny` -> the WORKSPACE state of that tool. The reset also removed this
//   agent's own `tool_search` block, so once its cage is lifted the engine
//   computes the cell from the workspace settings alone — which is the state
//   the sheet's own Workspace column already shows (ledgerRows.ts calls it "the
//   reference every agent cell is read against").
//
// TWO ROWS ARE LEFT TO THE ENGINE rather than answered optimistically: a NATIVE
// archetype, whose `off` and `deferred` defaults live in its own ruleset and
// `tool_search` and not in any file this reset can touch. A definition FILE that
// denies a tool in its own frontmatter is the one case this still reads too
// generously; the toast asks for the reload that settles it either way.

import type { ToolState } from './toolDeferConfig';

/** The workspace row for one tool, out of the same payload — `disabled` and
 *  `deferred` are the two flags acp/tools.ts writes per tool. */
function workspaceState(tool: Record<string, unknown>): ToolState {
  if (tool['disabled'] === true) return 'off';
  return tool['deferred'] === true ? 'deferred' : 'loaded';
}

/**
 * The cells to mask for ONE agent after its overrides were removed, as tool id
 * -> state. `removed` is what `removeSubagentToolOverrides` took out of
 * `permission`, tool id -> the rule string it deleted.
 *
 * Empty for a native row, and for any tool the payload has no workspace row for:
 * a mask with nothing to say must say nothing rather than invent a cell.
 */
export function resetCellStates(
  payload: Record<string, unknown>,
  agent: string,
  removed: Record<string, string>,
): Record<string, ToolState> {
  const rows = payload['subagents'];
  const row = (Array.isArray(rows) ? rows : []).find(
    (r) => r && typeof r === 'object' && (r as { agent?: unknown }).agent === agent,
  ) as { native?: unknown } | undefined;
  if (!row || row.native === true) return {};
  const tools = Array.isArray(payload['tools']) ? (payload['tools'] as Record<string, unknown>[]) : [];
  const states: Record<string, ToolState> = {};
  for (const [id, rule] of Object.entries(removed)) {
    if (rule === 'allow') {
      states[id] = 'off';
      continue;
    }
    if (rule !== 'deny') continue;
    const tool = tools.find((t) => t && t['id'] === id);
    if (tool) states[id] = workspaceState(tool);
  }
  return states;
}
