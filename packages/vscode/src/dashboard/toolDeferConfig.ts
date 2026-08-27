// The tool state control's write target in the GLOBAL origami.json. Extracted
// out of toolsPane.ts (t-kgtaac round 3) to keep that file under its cap — a
// self-contained read/merge/write unit, the same shape as firstFold.ts's
// writeModelConfig / writeAgentFrequencyPenalty / writeModelVision.
//
// THE STATE IS THREE-WAY AND SPANS TWO KEYS, deliberately: loaded/deferred ->
// `experimental.tool_search.{always,defer}`, off -> `tools: { <id>: false }`.
// They are not one key because they are not one question — tool_search decides
// how a tool is PRESENTED (full schema, or a catalog line), `tools` decides
// whether it exists for the model at all. An off tool is dropped before the
// presentation question is asked (engine/src/session/tools.ts), so folding off
// in as a third tool_search value would hide a capability switch in a cost setting.
//
// Pure Node I/O: no `vscode` import, so it needs no VS Code host to unit test.
// `toolsPane.ts` is the only caller.

import { globalConfigPath, readConfigForWrite, saveConfig } from './globalConfig';

/** The GLOBAL origami.json — same file and same target as the other config
 *  writers in this extension. `experimental.tool_search` is a
 *  workspace-agnostic "how I want the agent to work" setting, same category
 *  as those.
 *
 *  Re-exported rather than re-derived: this file used to hold its own
 *  `path.join(os.homedir(), '.config', ...)` copy, which ignored
 *  XDG_CONFIG_HOME and so wrote a file the engine never read (connections
 *  review finding 5). globalConfig.ts is now the single resolution. */
export { globalConfigPath };

function asObj(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function asStrArr(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

export type ToolState = 'loaded' | 'deferred' | 'off';

/**
 * Set one tool's state in the global origami.json.
 *
 * EVERY WRITE CLEARS ALL THREE PLACES FIRST, then sets exactly the one the new
 * state needs, so the file can never say two things about one tool — which
 * would show up as a control that will not move. `off` leaves the tool out of
 * BOTH tool_search lists on purpose: a stale `always` would silently pick the
 * next state for the user when they switch it back on. Backs up before writing
 * and throws on corrupt JSON rather than clobbering it — the same safety shape
 * as writeAgentFrequencyPenalty in firstFold.ts.
 *
 * The engine caches config per-instance (config/config.ts's `InstanceState`
 * has no file watcher), so this takes effect on the NEXT engine spawn, not
 * this one — the caller is responsible for saying "reload the window".
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

  // ON is the ABSENCE of a key, not `true`: an explicit `true` is indistinguishable
  // from the default to a reader, and leaves a record of every tool anyone ever
  // toggled cluttering a file people hand-edit.
  const tools = asObj(cfg['tools']);
  delete tools[id];
  if (state === 'off') tools[id] = false;
  if (Object.keys(tools).length > 0) cfg['tools'] = tools;
  else delete cfg['tools'];

  saveConfig(cfgPath, cfg, loaded);
  return cfgPath;
}

/** After writeToolState succeeds, the re-read catalog still carries the
 *  RUNNING engine's CACHED verdict for `id` (see the note above — it needs a
 *  reload) — patch the one entry we just confirmed on disk so the control
 *  shows the pending truth instead of silently springing back. Both fields are
 *  written, never one: leaving the old `deferred` in place beside a new
 *  `disabled` is exactly the two-things-at-once state the writer above works
 *  to keep out of the file. */
export function patchToolStatePayload(payload: Record<string, unknown>, id: string, state: ToolState): Record<string, unknown> {
  const tools = payload['tools'];
  if (!Array.isArray(tools)) return payload;
  const next = { deferred: state === 'deferred', disabled: state === 'off' };
  return { ...payload, tools: tools.map((t) => (t && typeof t === 'object' && (t as { id?: unknown }).id === id ? { ...t, ...next } : t)) };
}
