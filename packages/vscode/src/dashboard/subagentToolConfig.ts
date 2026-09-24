// The SUB-AGENT matrix's write target: one tool's state for ONE agent type, under that agent's own
// block in the global origami.json. The per-agent twin of toolDeferConfig.ts, and deliberately a
// separate file: the global writer owns two workspace-wide keys, this one owns `agent.<name>`, and
// folding them together would put "every chat" and "one delegate" behind the same function.
//
// The two keys, and why they are two (the same split toolDeferConfig.ts makes):
//   permission.<tool>            — whether the tool EXISTS for this agent (off)
//   tool_search.{always,defer}   — how it is PRESENTED when it does (loaded / deferred)
// The engine honours both at spawn: `agent/agent.ts` merges the block's `permission` last, and
// `session/tools.ts` overlays the block's `tool_search` on the workspace lists (ToolSearch.forAgent).
//
// Pure Node I/O, no vscode import. The session-length "engine hasn't caught up yet" cache lives in
// subagentPendingOverrides.ts, re-exported here so nothing outside this pair has to know it moved.

import { globalConfigPath, readConfigForWrite, saveConfig } from './globalConfig';
import type { ToolState } from './toolDeferConfig';
import { recordSubagentOverride } from './subagentPendingOverrides';

export {
  patchSubagentStatePayload,
  applyPendingSubagentOverrides,
  __resetPendingSubagentOverridesForTests,
} from './subagentPendingOverrides';

function asObj(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function asStrArr(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

/** An agent name the engine could actually look up. The name goes into a config KEY, so a value
 *  the webview invented (a path, an empty string, a `__proto__`) must be refused here and not
 *  written. Mirrors the engine's own entry-name rule: a definition file's basename. */
export function isAgentName(raw: unknown): raw is string {
  return typeof raw === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(raw) && raw !== 'constructor';
}

/**
 * Set one tool's state for one sub-agent type in the global origami.json.
 *
 * Every write CLEARS all three places for that tool first and then sets exactly what the new state
 * needs, so the block can never say two things about one tool — the same invariant the workspace
 * writer keeps.
 *
 * `current` is the live state the ENGINE reports for that cell, and it is what keeps the file to the
 * overrides actually needed to reach the requested state:
 *   - an explicit `allow` is written only when the cell is OFF, because only a deny can have put it
 *     there (the archetype's own definition: `general` denies `todowrite`, `explore` denies
 *     everything it does not name). Writing one anywhere else would also silence a permission ASK
 *     the user never said anything about, which is not what clicking "Loaded" asked for.
 *   - `always` is written only when the cell is not ALREADY loaded, since its whole job is to beat a
 *     default that would otherwise defer the tool.
 *
 * Takes effect on the NEXT engine spawn; the caller says "reload the window".
 */
export function writeSubagentToolState(
  agent: string,
  id: string,
  state: ToolState,
  current: ToolState,
): string {
  if (!isAgentName(agent)) throw new Error(`"${agent}" is not an agent name this can write.`);
  const cfgPath = globalConfigPath();
  const loaded = readConfigForWrite(cfgPath);
  const cfg: Record<string, unknown> = loaded?.cfg ?? {};

  const agents = asObj(cfg['agent']);
  const block = asObj(agents[agent]);

  const permission = asObj(block['permission']);
  delete permission[id];
  if (state === 'off') permission[id] = 'deny';
  else if (current === 'off') permission[id] = 'allow';
  if (Object.keys(permission).length > 0) block['permission'] = permission;
  else delete block['permission'];

  const search = asObj(block['tool_search']);
  const defer = asStrArr(search['defer']).filter((x) => x !== id);
  const always = asStrArr(search['always']).filter((x) => x !== id);
  // OFF clears both lists: a stale `always` would silently pick the next state the day the tool is
  // switched back on.
  if (state === 'deferred') defer.push(id);
  if (state === 'loaded' && current !== 'loaded') always.push(id);
  if (defer.length > 0) search['defer'] = defer; else delete search['defer'];
  if (always.length > 0) search['always'] = always; else delete search['always'];
  if (Object.keys(search).length > 0) block['tool_search'] = search;
  else delete block['tool_search'];

  // An agent block emptied of everything we own is removed rather than left as `{}` — clicking a
  // cell back to the state the engine already reports leaves nothing behind, and a file people
  // hand-edit should not collect the wreckage of toggles that went back to their defaults. A block
  // that still carries the user's OWN keys (model, prompt, description) is kept whole.
  if (Object.keys(block).length > 0) agents[agent] = block;
  else delete agents[agent];
  if (Object.keys(agents).length > 0) cfg['agent'] = agents;
  else delete cfg['agent'];

  saveConfig(cfgPath, cfg, loaded);
  // Recorded only once the write is on disk — a throw above (a bad agent name) must not mask a
  // cell that was never actually written. See subagentPendingOverrides.ts for why this exists.
  // `current` rides along as where the ledger FOUND the cell, which is what "Reset to defaults"
  // puts it back to while the engine still reports the override (subagentOverrideMask.ts).
  recordSubagentOverride(agent, id, state, current);
  return cfgPath;
}
