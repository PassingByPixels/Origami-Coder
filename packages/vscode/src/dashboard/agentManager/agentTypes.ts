// Agent Manager - agentTypes.ts (S6a): the "typed agents" seam. The board's
// agent picker now offers the engine's REAL agent types (ACP modes) instead of
// the old cosmetic hardcoded stub. Two jobs, both driven from the run lifecycle
// once a session's ACP client is up:
//   1. HARVEST - read the new session's live modes and union them into the
//      persisted roster (globalState via the host), broadcasting when it grew so
//      every picker refreshes. Runs for EVERY create (tsuru included) so the
//      roster fills the first time any session exists.
//   2. APPLY - for a typed run (agentName is a real mode id, not tsuru),
//      set THIS session's mode BEFORE the prompt. A bad id is FATAL, exactly
//      like a model-pin failure: 'agent type unavailable: <id>'. 'tsuru' means
//      "engine default" and NEVER calls setConfigOption (byte-identical to the
//      pre-S6a behaviour).
// The merge is a pure function so it is unit-tested without a host.

import type { RunContext } from './run';

export interface AgentType {
  id: string;
  name: string;
  /** True for the entry that IS the engine's default primary agent at harvest
   *  time (the session's `current` mode, read before any mode is set). "Tsuru
   *  (default)" already means "use the engine default", so the picker hides
   *  THIS entry - whatever `default_agent` resolves to (not a hardcoded 'build').
   *  Absent/false = a selectable non-default agent. */
  default?: boolean;
  /** The engine mode's description (ACP select-option `description`), carried
   *  through so the picker can show what each agent type is for. Absent if none. */
  description?: string;
}

/**
 * Map an ACP mode-select (options + current) into roster entries: value->id,
 * name->name, and the `current` mode flagged default (so the picker hides it -
 * "Tsuru (default)" already means it). The one place this mapping lives, shared
 * by the per-session harvest (agentModes) AND the S6c any-session pre-fill
 * (harvestAnySessionModes) so the two can never drift. null in -> null out.
 */
export function modesFromOption(
  opt: { current: string; options: Array<{ value: string; name: string; description?: string }> } | null | undefined,
): AgentType[] | null {
  return opt ? opt.options.map((o) => ({
    id: o.value, name: o.name, default: o.value === opt.current,
    ...(o.description ? { description: o.description } : {}),
  })) : null;
}

/**
 * Union `harvested` into `existing` by id (a harvested name OR default-flag
 * refreshes a stale entry); existing order is kept and new ids append. Returns
 * the new roster when anything changed, else null so the caller skips the
 * persist + broadcast. An empty harvest returns null (nothing to add).
 */
export function mergeAgentTypes(existing: AgentType[], harvested: AgentType[]): AgentType[] | null {
  const byId = new Map(existing.map((t) => [t.id, t]));
  let changed = false;
  for (const h of harvested) {
    const cur = byId.get(h.id);
    if (!cur || cur.name !== h.name || !!cur.default !== !!h.default || cur.description !== h.description) {
      byId.set(h.id, h);
      changed = true;
    }
  }
  return changed ? [...byId.values()] : null;
}

/**
 * Harvest this session's modes into the roster (broadcasting on a change), then
 * apply the requested agent type. Called after the model pin and before the
 * prompt. 'tsuru'/'' (and a legacy 'kami') set no mode (engine default). An unknown mode throws
 * 'agent type unavailable: <id>' - fatal to the run, mirroring the model-pin
 * pattern - which the run's catch turns into the row's error state.
 */
export async function syncAgentType(ctx: RunContext, sessionId: string, agentName: string): Promise<void> {
  const harvested = ctx.host.agentModes(sessionId);
  if (harvested && harvested.length > 0) {
    const merged = mergeAgentTypes(ctx.host.agentTypes(), harvested);
    if (merged) { ctx.host.saveAgentTypes(merged); ctx.broadcast(); }
  }
  // 'tsuru'/'' = engine default (no mode set). 'kami' was a board-only synthetic
  // type, since removed; tolerate a legacy queued 'kami' task the same way rather
  // than erroring on a mode id that never existed as a real ACP option.
  if (!agentName || agentName === 'tsuru' || agentName === 'kami') return;
  try {
    await ctx.host.setSessionAgentMode(sessionId, agentName);
  } catch {
    throw new Error(`agent type unavailable: ${agentName}`);
  }
}
