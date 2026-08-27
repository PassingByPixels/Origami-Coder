// The `tool_search` visibility gap (t-q41knp). `tool_search` is never a
// registry tool: packages/engine/src/session/tools.ts synthesizes it fresh
// per-turn, only once something is actually deferred (tool-search.ts's own
// `deferred()` hard-excludes its own id from the deferred set, since it
// cannot defer itself). `GET /experimental/tool` therefore never reports it,
// so the Tools pane rendered as if the tool that DOES the deferring did not
// exist — silently contradicting the pane's own note text (ToolsPane.svelte),
// which already names it. Append a synthetic row instead of an engine change:
// never deferred, and hardRequired (there is no toggle for "defer my own
// un-deferrer" — ToolCard.svelte already renders that state, disabled, for
// every other hard-required tool).
//
// Pure, no `vscode` import — toolsPane.ts is the only caller.

import type { ToolCatalogEntry } from '../acpExtTypes';

export const TOOL_SEARCH_ID = 'tool_search';

/** id-checked first so a future engine change that DOES report `tool_search`
 *  is a no-op here, never a duplicate row. */
export function withToolSearchRow(tools: ToolCatalogEntry[]): ToolCatalogEntry[] {
  if (tools.some((t) => t.id === TOOL_SEARCH_ID)) return tools;
  return [
    ...tools,
    {
      id: TOOL_SEARCH_ID,
      description: 'Loads the full schema of a tool deferred behind the catalog. Offered to the model once something is actually deferred; can never be deferred itself.',
      deferred: false,
      // Never switchable off either, and for the same reason it is never
      // deferred: it is not a registry tool, so there is no config key that
      // could reach it.
      disabled: false,
      source: 'builtin',
      hardRequired: true,
    },
  ];
}
