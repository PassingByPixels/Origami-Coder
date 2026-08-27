// t-r7c757 — the new-chat empty state's rotating tip list, extracted so the
// advance/seed rules are testable with no DOM. Math.random lives ONLY at the
// component's call site (ChatEmptyState.svelte); this file never calls it, so
// startTipIndex is deterministic under test given an injected seed.

/** The curated tip list, in display order. Entry 0 is the classic hint —
 *  rotation always starts SOMEWHERE in this list, never off it. Wording is
 *  owner-reviewed; keep verbatim. */
export const EMPTY_STATE_TIPS: readonly string[] = [
  'Ready — ask Tsuru to make a change. Type below to jump in.',
  'Run /wrap to close out a session — it writes the handoff and updates the wiki.',
  'Working with images on a text-only model? The Vision button lends it a pair of eyes.',
  'tool_search finds MCP tools by capability — ask for what you need, not a tool name.',
  'The sidebar is yours: + creates sections, drag chats between them.',
  'A blue dot on a tab — or a blue ring in the sidebar — means a chat is waiting on you.',
  "Sessions can message each other: ask for list_agents to see who's reachable.",
  'Pop a chat into its own editor tab to work side-by-side.',
  'Pick a sub-agent model on the model selector so heavy chats spawn light helpers.',
  'Right-click the compaction bar to set a lower auto-compact threshold.',
  'Plugins add skills and tools in one folder — origami agent-plugin add <dir>.',
];

/** The only advance rule: forward one step, wrapping the last tip back to
 *  the first. No going back, no skipping. */
export function nextTipIndex(current: number): number {
  return (current + 1) % EMPTY_STATE_TIPS.length;
}

/** Maps an injected seed in [0, 1) to a start index — the caller supplies the
 *  real randomness (Math.random()); this stays pure so a fixed seed always
 *  reproduces the same start under test. Clamped so a seed of exactly 1 (or
 *  any out-of-range float) still lands on a real index. */
export function startTipIndex(seed: number): number {
  const last = EMPTY_STATE_TIPS.length - 1;
  const i = Math.floor(seed * EMPTY_STATE_TIPS.length);
  return i < 0 ? 0 : i > last ? last : i;
}

/** t-r7c757 round 2 — the ONE tip shown in place of the rotation while this
 *  workspace has never been folded. Takes over the whole tip slot (no
 *  rotation, no timer) until /firstfold runs or the session reloads.
 *  Wording is owner-reviewed; keep verbatim. */
export const PINNED_SETUP_TIP =
  "This workspace isn't folded yet — run /firstfold to set up AGENTS.md, HANDOFF and the wiki.";
