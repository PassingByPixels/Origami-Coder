// Typed agents: the picker offers the engine's real ACP modes instead of a hardcoded stub.
// Harvesting unions a session's live modes into the persisted roster (broadcast on growth);
// applying pins a typed run's mode before the prompt, and an unknown id is fatal like a
// model-pin failure. 'tsuru' means engine default and calls no config.

import type { RunContext } from './run';

export interface AgentType {
  id: string;
  name: string;
  /** True for the entry that is the engine's current default agent at harvest time; the picker
   *  hides it since "Tsuru (default)" already means engine default. */
  default?: boolean;
  /** The engine mode's description (ACP select-option `description`), carried
   *  through so the picker can show what each agent type is for. Absent if none. */
  description?: string;
}

/** Map an ACP mode-select into roster entries, flagging the current mode as default. The one
 *  mapping shared by per-session harvest and any-session pre-fill so they can't drift. */
export function modesFromOption(
  opt: { current: string; options: Array<{ value: string; name: string; description?: string }> } | null | undefined,
): AgentType[] | null {
  return opt ? opt.options.map((o) => ({
    id: o.value, name: o.name, default: o.value === opt.current,
    ...(o.description ? { description: o.description } : {}),
  })) : null;
}

/** Union harvested types into existing by id; order is kept, new ids append. Returns null when
 *  nothing changed (skip persist+broadcast). */
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

/** Harvest this session's modes into the roster, then apply the requested agent type. An
 *  unknown mode throws (fatal to the run), mirroring the model-pin pattern. */
export async function syncAgentType(ctx: RunContext, sessionId: string, agentName: string): Promise<void> {
  const harvested = ctx.host.agentModes(sessionId);
  if (harvested && harvested.length > 0) {
    const merged = mergeAgentTypes(ctx.host.agentTypes(), harvested);
    if (merged) { ctx.host.saveAgentTypes(merged); ctx.broadcast(); }
  }
  // 'tsuru'/'' = engine default; a legacy 'kami' (removed board-only type) is tolerated the
  // same way rather than erroring.
  if (!agentName || agentName === 'tsuru' || agentName === 'kami') return;
  try {
    await ctx.host.setSessionAgentMode(sessionId, agentName);
  } catch {
    throw new Error(`agent type unavailable: ${agentName}`);
  }
}
