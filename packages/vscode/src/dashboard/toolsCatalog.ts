// Tools pane — the CATALOG READ. Extracted out of toolsPane.ts (which was at
// its 150-line cap) when the pane gained a problems list, because this is the
// one self-contained unit in that file: everything here answers "what does the
// engine currently say the tool list is", and nothing here touches `vscode`
// except through the host's `post`.
//
// It owns the host contract too (`ToolsPaneHost`/`ToolsPaneClient`), since the
// only thing the host is asked for is the client this module reads through.
//
// The three payload shapes are deliberately the SAME shape — always a
// `toolsData` with `tools`, `settings`, `codeMode` and `problems` — so the
// webview never has to branch on which of them it received.

import type { ToolCatalog, ToolCatalogEntry, ToolProblem } from '../acpExtTypes';
import { codeModeEnabled } from '../engineEnv';
import { withToolSearchRow } from './toolSearchRow';

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
    return { type: 'toolsData', tools: [], settings: null, codeMode, problems: [], error: 'Open a chat first — the tool list is read from a live engine connection.' };
  }
  try {
    const catalog = await host.client.listTools();
    // `problems` is a SIBLING of `tools`, not a row: a file that failed to load
    // produced no tool, so it has no id, no description and no state to set.
    // Defaulted to [] because an older engine does not send the field at all.
    const problems: ToolProblem[] = Array.isArray(catalog?.problems) ? catalog.problems : [];
    return { type: 'toolsData', tools: withToolSearchRow(catalog?.tools ?? []), settings: catalog?.settings ?? null, codeMode, problems };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { type: 'toolsData', tools: [], settings: null, codeMode, problems: [], error: `Could not read the tool list: ${message}` };
  }
}

/** Look up one entry in a freshly-read catalog — never trust a `source`,
 *  `location` or `hardRequired` claim the webview echoes back, only the id. */
export async function findEntry(host: ToolsPaneHost, id: string): Promise<ToolCatalogEntry | undefined> {
  const payload = await catalogPayload(host);
  const tools = payload['tools'];
  return Array.isArray(tools) ? (tools as ToolCatalogEntry[]).find((t) => t.id === id) : undefined;
}
