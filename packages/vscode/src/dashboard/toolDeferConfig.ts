// The tool state control's write target in the global origami.json. Extracted out of toolsPane.ts
// to keep it under its cap — a self-contained read/merge/write unit like firstFold.ts's other
// config writers.
// State is three-way and spans two keys deliberately: loaded/deferred ->
// `experimental.tool_search.{always,defer}`, off -> `tools: { <id>: false }`. They're not one key
// because tool_search decides how a tool is PRESENTED while `tools` decides whether it exists at
// all — folding off into tool_search would hide a capability switch in a cost setting.
// Pure Node I/O, no vscode import.

import { globalConfigPath, readConfigForWrite, saveConfig } from './globalConfig';

/** The global origami.json — same file and target as the other config writers. Re-exported from
 *  globalConfig.ts, the single resolution (this file used to hold its own path.join copy that
 *  ignored XDG_CONFIG_HOME and wrote a file the engine never read). */
export { globalConfigPath };

function asObj(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function asStrArr(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

export type ToolState = 'loaded' | 'deferred' | 'off';

/**
 * Set one tool's state in the global origami.json. Every write clears all
 * three places first, then sets exactly the one the new state needs, so the
 * file can never say two things about one tool. `off` clears both tool_search
 * lists too — a stale `always` would silently pick the next state when the
 * tool is re-enabled. Takes effect on the NEXT engine spawn; the caller says
 * "reload the window".
 */
export function writeToolState(id: string, state: ToolState): string {
  const cfgPath = globalConfigPath();
  const loaded = readConfigForWrite(cfgPath);
  const cfg: Record<string, unknown> = loaded?.cfg ?? {};

  const experimental = asObj(cfg['experimental']);
  const toolSearch = asObj(experimental['tool_search']);
  toolSearch['defer'] = asStrArr(toolSearch['defer']).filter((x) => x !== id);
  toolSearch['always'] = asStrArr(toolSearch['always']).filter((x) => x !== id);
  if (state === 'deferred') (toolSearch['defer'] as string[]).push(id);
  if (state === 'loaded') (toolSearch['always'] as string[]).push(id);
  experimental['tool_search'] = toolSearch;
  cfg['experimental'] = experimental;

  // ON is the absence of a key, not `true` — an explicit true is indistinguishable from default and
  // clutters a file people hand-edit.
  const tools = asObj(cfg['tools']);
  delete tools[id];
  if (state === 'off') tools[id] = false;
  if (Object.keys(tools).length > 0) cfg['tools'] = tools;
  else delete cfg['tools'];

  saveConfig(cfgPath, cfg, loaded);
  return cfgPath;
}

/** After writeToolState succeeds, patch the just-confirmed entry into the re-read catalog — the
 *  running engine's CACHED verdict still needs a reload. Both fields are written together, never
 *  one, to avoid the same two-things-at-once state the writer above guards against. */
export function patchToolStatePayload(payload: Record<string, unknown>, id: string, state: ToolState): Record<string, unknown> {
  const tools = payload['tools'];
  if (!Array.isArray(tools)) return payload;
  const next = { deferred: state === 'deferred', disabled: state === 'off' };
  return { ...payload, tools: tools.map((t) => (t && typeof t === 'object' && (t as { id?: unknown }).id === id ? { ...t, ...next } : t)) };
}
