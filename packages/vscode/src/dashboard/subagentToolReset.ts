// The SUB-AGENT LEDGER's 'Reset to defaults' (t-f3a74m): one agent, or the whole sheet, back on
// what the agent DEFINITIONS say — by REMOVING what the ledger put in the global origami.json
// rather than by writing a new set of overrides on top of it. Its own file because
// subagentToolConfig.ts owns the forward write and was at 105/130, and subagentToolWrites.ts at
// 183/210; the removal is the opposite direction through the same `agent.<name>` block.
//
// The archetype files are NOT touched here. A reset is about the user's overrides; the shipped
// defaults live in the definitions, and the seed sweep (seedGlobal.ts) is what puts them there.

import * as vscode from 'vscode';
import { globalConfigPath, readConfigForWrite, saveConfig } from './globalConfig';
import { isAgentName } from './subagentToolConfig';
import { resetSubagentOverrides } from './subagentPendingOverrides';
import { resetCellStates } from './subagentResetStates';
import { catalogPayload, postCatalog } from './toolsCatalog';
import type { ToolsPaneHost } from './toolsCatalog';

function asObj(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/**
 * Put ONE agent back on its definition's defaults (t-f3a74m): remove the keys this ledger
 * writes from `agent.<name>` and nothing else.
 *
 * What "the keys this ledger wrote" means, precisely:
 *   - `tool_search` — the ledger owns the whole key; it writes no other shape into it.
 *   - `permission.<tool>` entries whose value is a plain action STRING. That is the only
 *     shape `writeSubagentToolState` above ever writes. A path- or target-scoped OBJECT
 *     (`edit: { "*": deny, "*.md": allow }`) is hand-written and survives, because removing
 *     it would silently widen an agent the user narrowed on purpose.
 * Everything else in the block — model, prompt, description — is untouched, and an empty
 * block is pruned the same way a single write prunes it.
 *
 * Takes effect on the NEXT engine spawn; the caller says "reload the window". The rules it took
 * out of `permission` are reported back: they are the half the engine keeps voting on, and what
 * each cell shows until the reload is read from them (subagentResetStates.ts).
 */
export function removeSubagentToolOverrides(agent: string): { path: string; removed: number; rules: Record<string, string> } {
  if (!isAgentName(agent)) throw new Error(`"${agent}" is not an agent name this can write.`);
  const cfgPath = globalConfigPath();
  const loaded = readConfigForWrite(cfgPath);
  const cfg: Record<string, unknown> = loaded?.cfg ?? {};
  const agents = asObj(cfg['agent']);
  if (!(agent in agents)) return { path: cfgPath, removed: 0, rules: {} };

  const block = asObj(agents[agent]);
  let removed = 0;
  const rules: Record<string, string> = {};
  const permission = asObj(block['permission']);
  for (const [tool, rule] of Object.entries(permission)) {
    if (typeof rule !== 'string') continue;
    rules[tool] = rule;
    delete permission[tool];
    removed += 1;
  }
  if (Object.keys(permission).length > 0) block['permission'] = permission;
  else delete block['permission'];
  if (block['tool_search'] !== undefined) {
    delete block['tool_search'];
    removed += 1;
  }
  if (removed === 0) return { path: cfgPath, removed: 0, rules: {} };

  if (Object.keys(block).length > 0) agents[agent] = block;
  else delete agents[agent];
  if (Object.keys(agents).length > 0) cfg['agent'] = agents;
  else delete cfg['agent'];

  saveConfig(cfgPath, cfg, loaded);
  return { path: cfgPath, removed, rules };
}

/** Every sub-agent name the ENGINE is reporting right now. Read here rather than sent: a stale
 *  webview would otherwise leave a column behind, or name an agent that no longer exists. */
async function reportedAgents(host: ToolsPaneHost): Promise<{ payload: Record<string, unknown>; names: string[] }> {
  const payload = await catalogPayload(host);
  const rows = payload['subagents'];
  const names = (Array.isArray(rows) ? rows : []).map((row) => (row as { agent?: unknown })?.agent);
  return { payload, names: names.filter(isAgentName) };
}

/** The ledger's verb: `agent` names one column, or is absent for the whole sheet (which the
 *  webview confirms before it ever posts). Reports what it removed, zero included — a click
 *  that found nothing to undo must not look broken. */
export async function resetSubagentToolDefaults(host: ToolsPaneHost, agent: unknown): Promise<void> {
  const { payload, names } = await reportedAgents(host);
  const targets = agent === undefined ? names : names.filter((name) => name === agent);
  if (targets.length === 0) {
    // Two different emptinesses (t-fisfs5 R14). A named column that is gone is
    // "no such agent"; the WHOLE SHEET against an empty roster named a
    // sub-agent called `undefined`, because there was no name to print.
    vscode.window.showErrorMessage(
      agent === undefined
        ? 'The engine is not reporting any sub-agents, so there is nothing to reset.'
        : `The engine is not reporting a sub-agent called ${String(agent)}.`,
    );
    postCatalog(host, payload);
    return;
  }
  try {
    let removed = 0;
    const rules = new Map<string, Record<string, string>>();
    for (const name of targets) {
      const gone = removeSubagentToolOverrides(name);
      removed += gone.removed;
      rules.set(name, gone.rules);
    }
    const what = agent === undefined ? 'Every sub-agent is' : `${targets[0]} is`;
    vscode.window.showInformationMessage(
      removed === 0
        ? `${what} already on the shipped defaults, so nothing was removed.`
        : `${what} back on the shipped defaults - ${removed} override${removed === 1 ? '' : 's'} removed. Reload the window to apply.`,
    );
    // Re-read FIRST, then move the mask — ONCE, and only here. The engine is still answering with
    // the permission rules just deleted, so the mask is not cleared but held at what each reset cell
    // shows instead, read off this same answer (t-fiszlv R13). A second pass would overwrite the
    // exact `before` a cell written this session carries with the general answer beside it.
    const fresh = await catalogPayload(host);
    for (const [name, gone] of rules) resetSubagentOverrides(name, resetCellStates(fresh, name, gone));
    postCatalog(host, fresh);
  } catch (e) {
    vscode.window.showErrorMessage(e instanceof Error ? e.message : String(e));
    postCatalog(host, payload);
  }
}
