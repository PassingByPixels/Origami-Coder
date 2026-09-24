// The tool_search visibility gap. `tool_search` is never a registry tool — the engine synthesizes
// it fresh per-turn once something is deferred, so it never appears in GET /experimental/tool and
// the Tools pane rendered as if the tool that DOES the deferring didn't exist. This appends a
// synthetic row instead of an engine change: never deferred, always hardRequired.
// Pure, no vscode import.

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
      // Never switchable off either, for the same reason it's never deferred: it's not a registry
      // tool, so there's no config key that could reach it.
      disabled: false,
      source: 'builtin',
      hardRequired: true,
    },
  ];
}
