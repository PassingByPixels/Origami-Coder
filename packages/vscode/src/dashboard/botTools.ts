// botTools.ts — WHICH TOOLS a bot may use, as its def file states it.
//
// W6 ruling: bot permissions are a tick per tool, not a named tier. TOOL_IDS
// mirrors the engine's tool registry (botTools.test.ts fails on drift).
//
// THE UNIT IS A GATE, NOT A TOOL ID: the engine maps `edit`/`write`/
// `apply_patch` onto one permission key, so a checkbox per tool id would
// offer decisions that don't exist — one checkbox per gate is correct.
//
// A DENY IS A REMOVAL: `"*": deny` drops a tool from the model's map, so a
// ticked set really is "the tools this bot has", not "tools it will be asked about".
//
// Pure — no fs, no vscode.

import type { CollabPreset } from './agentManager/collabPresets';

/** The one tool that can never be denied — where the engine redirects a
 *  malformed tool call. Not offered as a tick. */
export const HARD_REQUIRED_TOOLS = ['invalid'];

/** Every tool the engine's registry can offer. Includes flag-gated tools so
 *  one doesn't read as "unknown" the moment it's turned on. */
export const TOOL_IDS = [
  'apply_patch', 'artifact_diff', 'artifact_get', 'artifact_list', 'artifact_publish', 'bash', 'board_create', 'board_register', 'board_repos', 'board_tickets', 'board_update', 'board_worktrees',
  'browser', 'chart', 'dream', 'edit', 'execute', 'file', 'flock_ask', 'flock_reply', 'flock_who', 'git_diff', 'glob', 'goal', 'grep',
  'invalid', 'list_agents', 'lsp', 'plan_exit', 'process', 'question', 'question_reply', 'read', 'remember',
  'screenshot', 'send_message', 'show_image', 'session_search', 'side_quest', 'skill', 'task', 'task_list', 'task_stop',
  'todowrite', 'webfetch', 'webmcp_call', 'webmcp_launch', 'webmcp_list', 'webmcp_note', 'webmcp_tools', 'websearch',
  'wiki_related', 'wiki_search', 'write',
];

/** Tool ids that share one permission key, keyed by that key. The engine's own
 *  mapping (Permission.disabled); anything absent from here gates on its own id. */
const SHARED_GATES: Record<string, string[]> = {
  edit: ['edit', 'write', 'apply_patch'],
};

/** The permission key the engine consults for one tool id. */
export function gateOf(toolId: string): string {
  for (const [key, ids] of Object.entries(SHARED_GATES)) if (ids.includes(toolId)) return key;
  return toolId;
}

/** One checkbox: the permission key it writes, and every tool it turns on or off. */
export interface ToolGate {
  key: string;
  tools: string[];
}

/**
 * The gates a list of tool ids collapses to, key-sorted. HARD_REQUIRED_TOOLS
 * are dropped — a checkbox that can't be unticked isn't a decision.
 */
export function gatesFor(toolIds: readonly string[]): ToolGate[] {
  const byKey = new Map<string, string[]>();
  for (const id of toolIds) {
    if (HARD_REQUIRED_TOOLS.includes(id)) continue;
    const key = gateOf(id);
    byKey.set(key, [...(byKey.get(key) ?? []), id]);
  }
  return [...byKey.entries()]
    .map(([key, tools]) => ({ key, tools: [...tools].sort() }))
    .sort((a, b) => a.key.localeCompare(b.key));
}

/** The fallback universe: what the picker offers with no engine to ask. */
export const TOOL_GATES: ToolGate[] = gatesFor(TOOL_IDS);

/**
 * Every gate — what a NEW bot is born ticked on (W9 ruling). Reads the live
 * catalog so a bot doesn't open with a row unticked that the engine actually
 * offers; falls back to the shipped mirror when no chat is open to ask.
 */
export function allToolKeys(catalog?: readonly string[]): string[] {
  return gatesFor(catalog && catalog.length > 0 ? catalog : TOOL_IDS).map((g) => g.key);
}

/**
 * What the retired Worker and Observer buttons used to tick — the exact
 * allow-sets of the two shipped permission blocks, so an existing bot opened
 * and saved without touching the checklist comes back unchanged. Kept
 * because `presetOfTools` still has to name a set for the card's chip.
 */
export const OBSERVER_TOOLS = ['glob', 'grep', 'read'];
export const WORKER_TOOLS = ['bash', 'edit', 'glob', 'grep', 'read'];

/**
 * Which preset a tick set IS, for the card's chip. Compared only over keys
 * this build knows, so an unknown permission key doesn't make every seeded
 * bot read as hand-edited.
 */
export function presetOfTools(ticked: readonly string[]): CollabPreset {
  const known = [...ticked].filter((key) => TOOL_GATES.some((g) => g.key === key)).sort();
  const same = (other: string[]) => known.length === other.length && known.every((k, i) => k === other[i]);
  if (same([...WORKER_TOOLS].sort())) return 'worker';
  if (same([...OBSERVER_TOOLS].sort())) return 'observer';
  return 'custom';
}

/**
 * The `permission:` block a tick set becomes: allow for every ticked key,
 * deny for every other one this build knows. `"*": deny` stays first and is
 * load-bearing — it closes a tool an older shell has never heard of.
 */
export function toolBlockFor(ticked: readonly string[]): string {
  const allow = [...new Set(ticked)].sort();
  const deny = TOOL_GATES.map((g) => g.key).filter((key) => !allow.includes(key));
  return ['permission:', '  "*": deny', ...allow.map((k) => `  ${k}: allow`), ...deny.map((k) => `  ${k}: deny`)].join('\n');
}

/** One flat `  key: allow|deny` line — the whole grammar a tick set can
 *  express. A nested per-command map does not match. */
const FLAT_LINE = /^[ \t]+(?:"([^"]+)"|([A-Za-z0-9_*-]+))[ \t]*:[ \t]*(allow|deny|ask)[ \t]*$/;

/**
 * The ticked keys a `permission:` block states, or undefined when it cannot
 * be told as a tick set.
 *
 * Two cases read as undefined: no block at all (engine defaults stand,
 * different from `[]`), or a block that isn't flat (a hand-scoped rule has
 * no matching tick and must not be silently narrowed) — such a block stays
 * `custom` and is copied verbatim.
 */
export function toolsFromBlock(block: string): string[] | undefined {
  const lines = block.replace(/\r\n/g, '\n').split('\n');
  if (!/^permission:[ \t]*$/.test(lines[0] ?? '')) return undefined;
  const out: string[] = [];
  for (const line of lines.slice(1)) {
    if (line.trim() === '') continue;
    const m = line.match(FLAT_LINE);
    if (!m) return undefined; // not a tick set — keep it verbatim
    const key = m[1] ?? m[2];
    if (key !== '*' && m[3] === 'allow') out.push(key);
  }
  return [...new Set(out)].sort();
}
