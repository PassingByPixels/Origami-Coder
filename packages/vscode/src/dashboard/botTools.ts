// botTools.ts — WHICH TOOLS a bot may use, as its def file states it.
//
// W6 owner ruling: "nobody cares what skills a bot has, only what tools". So a
// bot's permissions are no longer a named tier plus a canned block — they are a
// TICK PER TOOL. This module is the whole of that rule: the tool universe, how a
// tick becomes a `permission:` line, and how a block becomes ticks again.
//
// W9 owner ruling RETIRED THE PRESET BUTTONS. Worker and Observer used to sit
// above the checklist and pre-tick a set; a NEW bot is now born with EVERY gate
// ticked and the user takes away what it must not have (`allToolKeys`). The two
// SETS survive this file because they are not the buttons: `presetOfTools` reads
// a tick set back as a name, which is what the card's chip says and what the
// serializer's `steps:` budget is chosen by. A name for a shape is a reading; a
// button that stamps the shape was the control that went.
//
// THE UNIT IS A GATE, NOT A TOOL ID, and the difference is load-bearing. The
// engine decides whether a tool reaches the model in `Permission.disabled`
// (packages/engine/src/permission/index.ts): it maps `edit`, `write` and
// `apply_patch` onto the SINGLE permission key `edit`, and every other tool onto
// its own id. So `write: deny` in a def file parses fine and changes nothing —
// the `edit` key is what governs all three. A checkbox per tool ID would
// therefore offer two decisions that do not exist. One checkbox per GATE, named
// with every tool it governs, is the same list told truthfully.
//
// A DENY IS A REMOVAL, not a prompt. `Permission.disabled` drops a tool from the
// map the model is handed when the last rule matching its key is `"*": deny`, so
// the ticked set really is "the tools this bot has" rather than "the tools it
// will be asked about".
//
// THE UNIVERSE IS A MIRROR. `packages/engine` is not resolvable from this
// package (per-package installs), so TOOL_IDS is copied from the registry, with
// the house obligation a mirror carries here: botTools.test.ts reads
// packages/engine/src/tool/*.ts and fails when a tool is added there and not
// here. The live list is preferred at runtime anyway — the Bots pane reads the
// engine's own `list_tools` — and this is what the picker falls back to when no
// chat is open to read it through.
//
// Pure — no fs, no `vscode` — so every branch is exercised on strings.

import type { CollabPreset } from './agentManager/collabPresets';

/**
 * The one tool that can never be denied. `invalid` is where the engine redirects
 * a malformed tool call (session/llm.ts `experimental_repairToolCall`), so a def
 * that switched it off would break repair rather than restrict the bot — the
 * same set the engine names REPAIR_ONLY_TOOLS. It is not offered as a tick.
 */
export const HARD_REQUIRED_TOOLS = ['invalid'];

/** Every tool the engine's registry can offer a turn (tool/registry.ts). Some
 *  are behind runtime flags; listing them all is what stops a flag-gated tool
 *  reading as "unknown" the moment somebody turns it on. */
export const TOOL_IDS = [
  'apply_patch', 'bash', 'board_create', 'board_register', 'board_repos', 'board_tickets', 'board_update', 'board_worktrees',
  'browser', 'chart', 'dream', 'edit', 'execute', 'file', 'git_diff', 'glob', 'goal', 'grep',
  'invalid', 'list_agents', 'lsp', 'plan_exit', 'process', 'question', 'read', 'remember',
  'screenshot', 'send_message', 'session_search', 'skill', 'task', 'task_list', 'task_stop',
  'todowrite', 'webfetch', 'websearch', 'wiki_related', 'wiki_search', 'write',
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
 * The gates a list of tool ids collapses to, key-sorted. HARD_REQUIRED_TOOLS are
 * dropped — a checkbox that cannot be unticked is not a decision — and an id the
 * engine reported that this build has never heard of still gets its own gate, so
 * a user-file or plugin tool is tickable the moment the engine lists it.
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
 * EVERY gate, which is what a NEW bot is born ticked on (W9 owner ruling).
 *
 * READS THE LIVE CATALOG, and that is the whole of why it takes an argument. A
 * bot born on the shipped mirror while the running engine offers a tool this
 * build has never heard of would open with one row already unticked — "all
 * ticked" contradicted on screen by the very form claiming it. The picker builds
 * its rows from the same list (BotContractFields.svelte), so passing it here is
 * what keeps the two in step as the engine grows. An empty catalog is "no chat
 * open to ask", not "an engine with no tools", so it falls back to the mirror.
 */
export function allToolKeys(catalog?: readonly string[]): string[] {
  return gatesFor(catalog && catalog.length > 0 ? catalog : TOOL_IDS).map((g) => g.key);
}

/**
 * What the retired Worker and Observer buttons used to tick.
 *
 * Deliberately the exact allow-sets of the two shipped permission blocks
 * (collabPresets.ts), not a fresh opinion: those blocks are what every existing
 * bot already carries, so a def opened and saved without touching the checklist
 * comes back byte-identical in meaning. Worker builds; Observer only reads.
 *
 * KEPT after the buttons went because `presetOfTools` below still has to NAME a
 * set — a seeded bot's card should read "worker", not "5 tools" — and because
 * the serializer picks its `steps:` budget off that name.
 */
export const OBSERVER_TOOLS = ['glob', 'grep', 'read'];
export const WORKER_TOOLS = ['bash', 'edit', 'glob', 'grep', 'read'];

/**
 * Which preset a tick set IS, for the card's chip.
 *
 * Compared over the keys this build KNOWS, so the shipped blocks' `list: allow`
 * — a permission key no tool in this engine consults — does not make every
 * seeded bot read as hand-edited. An unknown key is preserved on write; it just
 * does not get a vote on what the set is called.
 */
export function presetOfTools(ticked: readonly string[]): CollabPreset {
  const known = [...ticked].filter((key) => TOOL_GATES.some((g) => g.key === key)).sort();
  const same = (other: string[]) => known.length === other.length && known.every((k, i) => k === other[i]);
  if (same([...WORKER_TOOLS].sort())) return 'worker';
  if (same([...OBSERVER_TOOLS].sort())) return 'observer';
  return 'custom';
}

/**
 * The `permission:` block a tick set becomes — allow for every ticked key, deny
 * for every other one this build knows.
 *
 * `"*": deny` stays FIRST and is the load-bearing line: it is what closes a tool
 * this build has never heard of, so a def written by an older shell cannot
 * silently hand a newer engine's tool to a bot nobody granted it to. The
 * explicit denies after it are emphasis on the same answer, and they are what
 * makes the file readable as a decision rather than as an omission.
 */
export function toolBlockFor(ticked: readonly string[]): string {
  const allow = [...new Set(ticked)].sort();
  const deny = TOOL_GATES.map((g) => g.key).filter((key) => !allow.includes(key));
  return ['permission:', '  "*": deny', ...allow.map((k) => `  ${k}: allow`), ...deny.map((k) => `  ${k}: deny`)].join('\n');
}

/** One flat `  key: allow|deny` line, which is the whole grammar a tick set can
 *  express. Anchored so the value has to end the line: a `bash:` that opens a
 *  nested per-command map does not match, and that is the point. */
const FLAT_LINE = /^[ \t]+(?:"([^"]+)"|([A-Za-z0-9_*-]+))[ \t]*:[ \t]*(allow|deny|ask)[ \t]*$/;

/**
 * The ticked keys a `permission:` block states, or undefined when the block
 * cannot be told as a tick set.
 *
 * TWO WAYS TO GET UNDEFINED, and collapsing them would be a bug either way:
 *  - THERE IS NO BLOCK. The def never said anything about tools, so the engine's
 *    own defaults stand. That is different from `[]`, which is a bot
 *    deliberately allowed nothing.
 *  - THE BLOCK IS NOT FLAT. A hand-tuned block can scope one tool to a pattern
 *    (`bash:` then `"git status": allow`), and a checklist has no tick that
 *    means "only this command". Reading it as `bash unticked` and writing that
 *    back would NARROW an agent its author had deliberately opened — the exact
 *    silent rewrite collabAgentDef.ts's custom-block rule exists to refuse. So
 *    such a block stays `custom` and is copied out verbatim, and the editor says
 *    so rather than showing ticks that do not describe it.
 *
 * Only `allow` counts as a tick, and `"*"` is skipped — it is the base the other
 * lines are read against, never a tool.
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
