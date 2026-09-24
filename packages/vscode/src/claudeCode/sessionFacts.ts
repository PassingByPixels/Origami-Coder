// sessionFacts.ts — what the CLI tells us about a passthrough session, and how to say it back
// without over-claiming.
// Three presentation truths: (1) `total_cost_usd` is real money only when an API key paid, not on a
// plan (`apiKeySource === "none"`) — rendering it otherwise invents a bill. (2) On a plan, the
// composer shows headroom (`rate_limit_event`) in that same slot instead. (3) `init.skills` is a
// strict subset of `init.slash_commands`; the honest headline count is the command list, since that
// is also what the `/` palette shows.

import type { ClaudeEvent } from './protocol';

// The headroom PILL left for usagePill.ts in phase 2 (this file was 198 of a
// 215 cap and the pill grew a countdown). Re-exported so every existing import
// path still resolves — the same courtesy translator.ts does for sessionState.
export { rateLimitPillOf, usagePillText, windowLabel, type RateLimitPill } from './usagePill';

export interface SessionFacts {
  version: string;
  model: string;
  /** '' when the CLI did not say; 'none' means a subscription. */
  apiKeySource: string;
  tools: number;
  servers: number;
  /** `init.slash_commands` — every name the CLI executes for THIS session. */
  commands: readonly string[];
  /** `init.skills` — a strict SUBSET of `commands`; see the header. */
  skills: readonly string[];
  /** `init.memory_paths` values — the memory roots the child loaded. */
  memoryPaths: readonly string[];
}

function str(v: unknown): string { return typeof v === 'string' ? v : ''; }

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

/** `system/init` → the facts, or null for every other event. */
export function factsOf(ev: ClaudeEvent): SessionFacts | null {
  if (ev.type !== 'system' || ev.subtype !== 'init') return null;
  const memory = ev.memory_paths;
  return {
    version: str(ev.claude_code_version),
    model: str(ev.model),
    apiKeySource: str(ev.apiKeySource),
    tools: Array.isArray(ev.tools) ? ev.tools.length : 0,
    servers: Array.isArray(ev.mcp_servers) ? ev.mcp_servers.length : 0,
    commands: strings(ev.slash_commands),
    skills: strings(ev.skills),
    memoryPaths: memory && typeof memory === 'object' && !Array.isArray(memory)
      ? strings(Object.values(memory as Record<string, unknown>))
      : [],
  };
}

/**
 * Is this session on a plan rather than an API key? Unknown counts as a plan — hiding a real spend
 *  figure costs less than showing a notional one that tells the user they were billed for something
 *  they were not.
 */
export function onSubscription(apiKeySource: string): boolean {
  return apiKeySource === '' || apiKeySource === 'none';
}

/**
 * The transcript's "connected" line. Counts only the command list, not the skills subset, since
 *  that is the only roster the palette can also show. `memory` is named only when the child
 *  actually loaded a root.
 *
 * `origin` is the bind-time clause ("new session in <cwd>"), folded into this line rather than
 *  posted separately, so a new chat does not open with three overlapping system rows.
 */
export function connectedLine(f: SessionFacts, slashSkills: boolean, origin = ''): string {
  const bits = [
    `Claude Code${f.version ? ` ${f.version}` : ''} connected`,
    f.model ? `model ${f.model}` : '',
    f.tools ? `${f.tools} tools` : '',
    f.servers ? `${f.servers} MCP servers` : '',
    slashSkills && f.commands.length ? `${f.commands.length} commands on /` : '',
    origin,
  ].filter(Boolean);
  const own = f.memoryPaths.length
    ? 'Your own settings, hooks, memory and MCP servers are in force.'
    : 'Your own settings, hooks and MCP servers are in force.';
  return `${bits.join(' · ')}. ${own}`;
}

/** The bind-time clause the line above ends on — beside the sentence it joins. */
export function originClause(resuming: boolean, cwd: string): string {
  return !cwd ? '' : resuming ? `resuming your last session in ${cwd}` : `new session in ${cwd}`;
}

/** What `connectedPosts` needs off the state, declared structurally so the
 *  dependency still runs one way. `lastConnected` is written through. */
interface ConnectedMemo {
  readonly sessionId: string;
  readonly model?: string;
  readonly slashSkills: boolean;
  /** The bind-time clause. Fixed for the life of the binding. */
  readonly origin?: string;
  lastConnected?: string;
}

/**
 * The connected line, once — and again only when it says something different.
 *
 * The child is parked after idle minutes or a settings change and respawns with `--resume`, writing
 *  a second `system/init` for the same conversation. Without dedup, an idle chat would accumulate
 *  one identical "connected" paragraph per respawn.
 *
 * The rendered line itself is the comparison: it already carries every fact that could change
 *  (version, model, counts, memory). A respawn that changes none of them is silence; a re-bind
 *  always prints. Only this line is deduped — the funding meter and `/` command rows are live state
 *  and are resent every time.
 */
export function connectedPosts(
  st: ConnectedMemo,
  facts: SessionFacts,
): Array<{ type: string; text: string; sessionId: string }> {
  const text = connectedLine({ ...facts, model: st.model ?? facts.model }, st.slashSkills, st.origin ?? '');
  if (text === st.lastConnected) return [];
  st.lastConnected = text;
  return [{ type: 'system', text, sessionId: st.sessionId }];
}

/** The category every passthrough row carries, so the `/` palette shows them as
 *  one block instead of scattering them through the engine's own commands. */
export const PALETTE_CATEGORY = 'Claude Code';

export interface PaletteCommand { name: string; description: string; category: string; }

/** The dropdown gives a description ONE line; the CLI's run to whole paragraphs
 *  (the longest on this machine is 460 characters). Cut on a word boundary. */
function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= 110) return flat;
  const cut = flat.slice(0, 110);
  const sp = cut.lastIndexOf(' ');
  return `${(sp > 60 ? cut.slice(0, sp) : cut).trimEnd()}…`;
}

/**
 * The `/` rows for a passthrough cell. Names come from `init.slash_commands` — the set the CLI
 *  actually executes, the only list that can promise a pick will work. Descriptions come from the
 *  `initialize` control_response and fall back to a bare name when that frame has not arrived.
 */
export function paletteCommands(
  names: readonly string[],
  descriptions: ReadonlyMap<string, string>,
): PaletteCommand[] {
  return names.map((name) => ({
    name: `/${name}`,
    description: descriptions.get(name) ?? '',
    category: PALETTE_CATEGORY,
  }));
}

/** The `initialize` control_response's own command list — the same names as
 *  `init.slash_commands`, carrying the prose. Empty map for any other frame. */
export function commandDescriptionsOf(ev: ClaudeEvent): Map<string, string> {
  const out = new Map<string, string>();
  if (ev.type !== 'control_response') return out;
  const outer = (ev.response ?? {}) as Record<string, unknown>;
  const inner = (outer.response ?? {}) as Record<string, unknown>;
  const cmds = Array.isArray(inner.commands) ? inner.commands : [];
  for (const c of cmds) {
    if (!c || typeof c !== 'object' || Array.isArray(c)) continue;
    const rec = c as Record<string, unknown>;
    const name = str(rec.name);
    if (name) out.set(name, oneLine(str(rec.description)));
  }
  return out;
}
