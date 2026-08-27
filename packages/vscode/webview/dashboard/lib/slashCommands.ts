// Pillar 3 dashboard upgrade (2026-05-22) — shared slash command
// types and helpers. Both InputBar (autocomplete dropdown) and
// SlashCommandPalette (Cmd-K modal) consume the same wire format
// (`availableCommands` message from the extension) and need the
// same `inferCategory` mapping. Lifting the helper here avoids the
// drift risk of two parallel copies.

export interface SlashCommand {
  /** Display name including leading `/`, e.g. `/plan`. */
  name: string;
  /** One-line description shown in autocomplete + palette. */
  description: string;
  /** Inferred grouping for the palette UI. */
  category: string;
}

/** Fallback list shown until the extension forwards the runtime's
 * `availableCommands` message. Keep small — these are baseline
 * defaults the user will probably need before the first turn lands. */
export const FALLBACK_COMMANDS: SlashCommand[] = [
  { name: '/help',   description: 'Show all commands',          category: 'General' },
  { name: '/clear',  description: 'Wipe chat and reset context', category: 'Session' },
  { name: '/status', description: 'Agent, model, context stats', category: 'Info' },
  { name: '/model',  description: 'List/switch models',          category: 'Info' },
  { name: '/memory', description: 'Search memory (FTS5)',        category: 'Memory' },
];

/** Shell-only commands the ENGINE never lists — intercepted host-side, so they
 * survive an `availableCommands` update rather than being replaced by it.
 * Moved here from InputBar.svelte (at its architecture cap) with the fallback
 * list below, which was already a hand-kept second copy of FALLBACK_COMMANDS. */
export const SHELL_COMMANDS: SlashCommand[] = [
  { name: '/firstfold', description: 'Set up this workspace (scaffold + model)', category: 'Setup' },
  { name: '/spend', description: 'Show cost — this chat + this month', category: 'Info' },
  { name: '/loop', description: 'Re-run a prompt on a timer (e.g. every 30m)', category: 'Mode' },
  { name: '/compose', description: 'Help me write a good /loop', category: 'Mode' },
];

/** What the composer offers before the engine has said anything: the baseline
 *  vocabulary plus the shell's own. */
export const DEFAULT_COMMANDS: SlashCommand[] = [...FALLBACK_COMMANDS, ...SHELL_COMMANDS];

/** Map a raw command name (no leading slash) to its category bucket
 * for the palette grouping. Pulled out of InputBar so the palette
 * uses the exact same categorisation. */
export function inferCategory(name: string): string {
  if (['help', 'config', 'status', 'session', 'context', 'model', 'agent', 'profile'].includes(name)) return 'Info';
  if (['clear', 'new', 'paste', 'copy', 'scroll', 'export'].includes(name)) return 'Session';
  if (['memory', 'remember', 'capture', 'brain'].includes(name)) return 'Memory';
  if (['board', 'tasks', 'goals'].includes(name)) return 'Board';
  if (['think', 'quick', 'normal'].includes(name)) return 'Reasoning';
  if (['plan', 'default', 'auto', 'bypass', 'permissions'].includes(name)) return 'Mode';
  if (['tools', 'reload', 'perf', 'web'].includes(name)) return 'Tools';
  if (['retry', 'undo', 'cancel', 'quit'].includes(name)) return 'Control';
  return 'Other';
}

/** Build a `SlashCommand` from a runtime `availableCommands` entry.
 * Accepts the loose `any` shape from the message payload + coerces
 * defensively. Strips an existing leading `/` and re-adds it
 * canonically so display is consistent. */
export function buildSlashCommand(raw: { name?: unknown; description?: unknown }): SlashCommand {
  const rawName = String(raw?.name ?? '').replace(/^\//, '');
  return {
    name: '/' + rawName,
    description: String(raw?.description ?? ''),
    category: inferCategory(rawName),
  };
}

/** Tiny case-insensitive substring matcher for the palette. Tries
 * name match first (so `/pl` hits `/plan` before `/help` which has
 * "plan" in its description). */
export function filterCommands(commands: SlashCommand[], query: string): SlashCommand[] {
  if (!query) return commands;
  const q = query.toLowerCase().replace(/^\//, '');
  const nameHits: SlashCommand[] = [];
  const descHits: SlashCommand[] = [];
  for (const c of commands) {
    const stripped = c.name.replace(/^\//, '').toLowerCase();
    if (stripped.includes(q)) nameHits.push(c);
    else if (c.description.toLowerCase().includes(q)) descHits.push(c);
  }
  return [...nameHits, ...descHits];
}
