// Tools pane — the catalog read, extracted out of toolsPane.ts when it gained a problems list; the
// one self-contained unit in that file (touches no vscode except through host.post).
// Owns the host contract (ToolsPaneHost/ToolsPaneClient) too, since the client is the only thing
// the host is asked for. All three payload shapes are the same `toolsData` shape so the webview
// never branches on which it received.

import type { ToolCatalog, ToolCatalogEntry, ToolProblem, SubagentToolRow } from '../acpExtTypes';
import { codeModeEnabled } from '../engineEnv';
import { withToolSearchRow } from './toolSearchRow';
import { applyPendingSubagentOverrides } from './subagentPendingOverrides';

export interface ToolsPaneClient {
  listTools(cwd?: string): Promise<ToolCatalog>;
}

export interface ToolsPaneHost {
  /** The active chat's engine connection, if any. The catalog is an engine read, so with no session there is no answer. */
  client?: ToolsPaneClient;
  post(message: Record<string, unknown>): void;
}

export async function catalogPayload(host: ToolsPaneHost): Promise<Record<string, unknown>> {
  const codeMode = codeModeEnabled();
  if (!host.client) {
    return { type: 'toolsData', tools: [], settings: null, codeMode, problems: [], subagents: [], error: 'Open a chat first — the tool list is read from a live engine connection.' };
  }
  try {
    const catalog = await host.client.listTools();
    // `problems` is a sibling of `tools`, not a row: a file that failed to load produced no tool,
    // so it has no id/description/state. Defaults to [] for an older engine.
    const problems: ToolProblem[] = Array.isArray(catalog?.problems) ? catalog.problems : [];
    // `subagents` is a sibling of `tools` for the same reason `problems` is: a state belongs to an
    // agent, not to a tool. [] for an older engine, which renders as "no sub-agent rows".
    const subagents: SubagentToolRow[] = Array.isArray(catalog?.subagents) ? catalog.subagents : [];
    // Deliberately UNMASKED by any pending subagent override: `setSubagentState` (toolsPane.ts)
    // reads this to resolve a cell's real `current` state before deciding what override a write
    // needs, and that decision has to see the engine's own baseline, not our own not-yet-live
    // write reflected back at us — masking here fed a write its own prior override as if the
    // engine had confirmed it, which stopped a cell cycled back to its default from ever cleaning
    // its block away again. The mask belongs only at the POST boundary — see `applyPendingSubagentOverrides`.
    return { type: 'toolsData', tools: withToolSearchRow(catalog?.tools ?? []), settings: catalog?.settings ?? null, codeMode, problems, subagents };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { type: 'toolsData', tools: [], settings: null, codeMode, problems: [], subagents: [], error: `Could not read the tool list: ${message}` };
  }
}

/** Look up one entry in a freshly-read catalog — never trust a `source`,
 *  `location` or `hardRequired` claim the webview echoes back, only the id. */
export async function findEntry(host: ToolsPaneHost, id: string): Promise<ToolCatalogEntry | undefined> {
  const payload = await catalogPayload(host);
  const tools = payload['tools'];
  return Array.isArray(tools) ? (tools as ToolCatalogEntry[]).find((t) => t.id === id) : undefined;
}

/** Post a catalog payload, masked with every subagent cell confirmed this session (t-dkk5jd) — a
 *  raw `catalogPayload()` answer can still carry the engine's own stale verdict for an earlier
 *  cell. Every post the tools pane makes should go through this, EXCEPT the reads inside
 *  `setSubagentState` (toolsPane.ts) that resolve a write's `current` state — those need
 *  `catalogPayload()` unmasked, per its own comment. */
export function postCatalog(host: ToolsPaneHost, payload: Record<string, unknown>): void {
  host.post(applyPendingSubagentOverrides(payload));
}
