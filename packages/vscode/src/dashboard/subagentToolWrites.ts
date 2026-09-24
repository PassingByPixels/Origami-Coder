// The SUB-AGENT LEDGER's writes, host side (t-f1j2y3): one cell, one whole
// column, or one tool across every agent. Extracted out of toolsPane.ts, which
// was at 148/150 when the two bulk verbs landed — and which now keeps only the
// workspace-wide writes and the dispatch line, the same split it made when the
// catalog read left for toolsCatalog.ts.
//
// WHY THE BULK VERBS ARE HOST-SIDE AT ALL. A column is one message per tool if
// the webview loops, and each of those is a config read, a config write, an
// information toast and a catalog post — forty toasts for one click. Here the
// loop is one message: one pass over a FRESHLY READ catalog, one toast, one
// post.
//
// Nothing here trusts the webview past a tool id, an agent name and one of
// three state words. Which tools exist, what state each is in now, and which
// cells may not be written at all are all resolved from that fresh read.

import * as vscode from 'vscode';
import type { ToolCatalogEntry, SubagentToolRow } from '../acpExtTypes';
import { writeSubagentToolState, isAgentName } from './subagentToolConfig';
import { resetSubagentToolDefaults } from './subagentToolReset';
import type { ToolState } from './toolDeferConfig';
import { parseToolState, toolStateNotice } from './toolStateMessage';
import { catalogPayload, postCatalog } from './toolsCatalog';
import type { ToolsPaneHost } from './toolsCatalog';

export const SUBAGENT_TOOL_MESSAGE_TYPES = [
  'toolsSetSubagentState',
  'toolsSetSubagentColumn',
  'toolsSetSubagentRow',
  'toolsResetSubagentDefaults',
] as const;

/** The peer tools, and the reason a ledger cell for one can be locked. MIRRORS
 *  `NESTING_TOOLS` in webview/dashboard/panes/ledgerRows.ts — the webview
 *  cannot import this file (tsconfig.webview.json pins rootDir to `webview/`),
 *  so the list is stated twice and a drift guard in architecture.test.ts fails
 *  when the two stop agreeing. The rule itself is the engine's
 *  (agent/subagent-permissions.ts): a sub-agent gets a peer tool only if its
 *  own definition names it, and a definition that names it never reports the
 *  tool as `off` — so `off` on one of these is a cell no write can move. */
const NESTING_TOOLS = new Set(['task', 'send_message', 'list_agents']);

/** The tool's own state, the same order the pane and the engine take it in. */
const workspaceStateOf = (entry: ToolCatalogEntry): ToolState =>
  entry.disabled ? 'off' : entry.deferred ? 'deferred' : 'loaded';

const stateOf = (row: SubagentToolRow, id: string): ToolState => parseToolState(row.states?.[id]) ?? 'loaded';

/** Whether this cell may be written at all — the host's own check, never the
 *  `disabled` attribute the webview drew. */
function settable(entry: ToolCatalogEntry, current: ToolState): boolean {
  if (entry.hardRequired) return false;
  return !(NESTING_TOOLS.has(entry.id) && current === 'off');
}

interface Catalog {
  payload: Record<string, unknown>;
  tools: ToolCatalogEntry[];
  rows: SubagentToolRow[];
}

async function read(host: ToolsPaneHost): Promise<Catalog> {
  // Deliberately the UNMASKED read: every write below decides what override it
  // needs from the state the ENGINE reports, not from our own pending one.
  const payload = await catalogPayload(host);
  const tools = payload['tools'];
  const rows = payload['subagents'];
  return {
    payload,
    tools: Array.isArray(tools) ? (tools as ToolCatalogEntry[]) : [],
    rows: Array.isArray(rows) ? (rows as SubagentToolRow[]) : [],
  };
}

/** Apply one state to a list of (agent row, tool) pairs. Returns how many cells
 *  actually changed — a pair already in the wanted state is not rewritten, so a
 *  bulk click never puts an override in the file for a default it agrees with. */
function apply(pairs: Array<{ row: SubagentToolRow; entry: ToolCatalogEntry; want: ToolState }>): number {
  let changed = 0;
  for (const { row, entry, want } of pairs) {
    const current = stateOf(row, entry.id);
    if (!settable(entry, current) || current === want) continue;
    writeSubagentToolState(row.agent, entry.id, want, current);
    changed += 1;
  }
  return changed;
}

/** Report what a bulk write did and re-post. `changed` of 0 is said out loud:
 *  a click that found every cell already in that state must not look broken. */
async function finish(host: ToolsPaneHost, changed: number, what: string): Promise<void> {
  vscode.window.showInformationMessage(
    changed === 0
      ? `${what} — every settable cell was already there, so nothing was written.`
      : `${what} — ${changed} cell${changed === 1 ? '' : 's'} written. Reload the window to apply.`,
  );
  postCatalog(host, await catalogPayload(host)); // postCatalog masks every cell written this session
}

/** One cell. The agent, the tool and the CURRENT state are all resolved against
 *  a fresh catalog read — never off whatever the webview echoed back — because
 *  the current state decides which overrides the write has to put in the file
 *  (subagentToolConfig.ts). */
async function setCell(host: ToolsPaneHost, agent: unknown, id: unknown, raw: unknown): Promise<void> {
  if (!isAgentName(agent) || typeof id !== 'string' || !id) return;
  const state = parseToolState(raw);
  if (!state) return; // a state the webview invented is never written
  const catalog = await read(host);
  const row = catalog.rows.find((r) => r?.agent === agent);
  if (!row) {
    vscode.window.showErrorMessage(`The engine is not reporting a sub-agent called ${agent}.`);
    postCatalog(host, catalog.payload);
    return;
  }
  // A tool the catalog does not name falls through to the write, which refuses
  // it on its own terms — the guard here is the LOCK, not existence.
  const entry = catalog.tools.find((t) => t.id === id);
  if (entry && !settable(entry, stateOf(row, id))) {
    vscode.window.showErrorMessage(`${id} has no state to set for ${agent}.`);
    postCatalog(host, catalog.payload);
    return;
  }
  try {
    writeSubagentToolState(agent, id, state, stateOf(row, id));
  } catch (e) {
    vscode.window.showErrorMessage(e instanceof Error ? e.message : String(e));
    postCatalog(host, catalog.payload);
    return;
  }
  vscode.window.showInformationMessage(`${agent}: ${toolStateNotice(id, state)}`);
  postCatalog(host, await catalogPayload(host)); // postCatalog masks this cell + every earlier one
}

/** A whole column: one agent, every settable tool, one state. */
async function setColumn(host: ToolsPaneHost, agent: unknown, raw: unknown): Promise<void> {
  if (!isAgentName(agent)) return;
  const state = parseToolState(raw);
  if (!state) return;
  const catalog = await read(host);
  const row = catalog.rows.find((r) => r?.agent === agent);
  if (!row) {
    vscode.window.showErrorMessage(`The engine is not reporting a sub-agent called ${agent}.`);
    postCatalog(host, catalog.payload);
    return;
  }
  try {
    const changed = apply(catalog.tools.map((entry) => ({ row, entry, want: state })));
    await finish(host, changed, `${agent}: every settable tool set to ${state}`);
  } catch (e) {
    vscode.window.showErrorMessage(e instanceof Error ? e.message : String(e));
    postCatalog(host, catalog.payload);
  }
}

/** One tool across every agent, set to that tool's OWN workspace state — the
 *  ledger's "→ all agents". The target is read here rather than sent: the
 *  workspace state is the one thing the webview could get wrong and the one
 *  thing this row is defined by. */
async function setRow(host: ToolsPaneHost, id: unknown): Promise<void> {
  if (typeof id !== 'string' || !id) return;
  const catalog = await read(host);
  const entry = catalog.tools.find((t) => t.id === id);
  if (!entry) {
    vscode.window.showErrorMessage(`The engine is not reporting a tool called ${id}.`);
    postCatalog(host, catalog.payload);
    return;
  }
  const want = workspaceStateOf(entry);
  try {
    const changed = apply(catalog.rows.map((row) => ({ row, entry, want })));
    await finish(host, changed, `${id}: every agent set to the workspace state (${want})`);
  } catch (e) {
    vscode.window.showErrorMessage(e instanceof Error ? e.message : String(e));
    postCatalog(host, catalog.payload);
  }
}

export async function handleSubagentToolMessage(
  host: ToolsPaneHost,
  m: { type?: string; [k: string]: unknown },
): Promise<void> {
  if (m.type === 'toolsSetSubagentState') await setCell(host, m.agent, m.id, m.state);
  else if (m.type === 'toolsSetSubagentColumn') await setColumn(host, m.agent, m.state);
  else if (m.type === 'toolsSetSubagentRow') await setRow(host, m.id);
  else if (m.type === 'toolsResetSubagentDefaults') await resetSubagentToolDefaults(host, m.agent);
}
