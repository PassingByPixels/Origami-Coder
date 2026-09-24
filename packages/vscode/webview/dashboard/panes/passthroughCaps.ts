// passthroughCaps.ts — WHICH chat affordances a Claude Code passthrough cell
// can honour, in one table.
//
// A passthrough chat is driven by the user's own `claude` CLI, not by the
// Origami engine. Five controls in the chat surface therefore have nothing
// behind them, and the rule is that they HIDE rather than fail:
//
//   rewind        — reverting a turn needs the engine's transcript + worktree
//                   snapshot. The CLI keeps its own history and exposes no
//                   revert, so the button would restore nothing.
//   compaction    — /compact is an engine command. Claude Code compacts on its
//                   own schedule and takes no instruction from us.
//   insights      — the Insights view lists the files feeding the ENGINE's
//                   system prompt. A passthrough turn is not built from them.
//   subagentModel — the sub-agent model override is an engine session config
//                   option; the CLI routes its own Task children.
//   secondOpinion — the review digest is read out of an engine session's turn.
//
// Declared webview-side and mirrored host-side (claudeCodeManager.ts owns the
// kind string that arrives on `sessionCreated`); the mirror has a drift test —
// a .ts leaf under webview/ may not import from src/ at all (TS6059).

/** The `kind` a passthrough chat cell carries. Engine chats send no kind. */
export const PASSTHROUGH_KIND = 'claude';

export type Capability = 'rewind' | 'compaction' | 'insights' | 'subagentModel' | 'secondOpinion';

/** Every capability listed here is OFF for a passthrough cell. Phase 2 removes
 *  entries from this list as each one gets a real implementation; nothing else
 *  in the UI has to change when it does. */
export const PASSTHROUGH_OFF: readonly Capability[] = [
  'rewind', 'compaction', 'insights', 'subagentModel', 'secondOpinion',
];

export function isPassthrough(kind: string | undefined | null): boolean {
  return kind === PASSTHROUGH_KIND;
}

/** The single question every gated render site asks. An engine chat (no kind)
 *  keeps everything, which is why adding this changes nothing for it. */
export function capabilityOn(kind: string | undefined | null, cap: Capability): boolean {
  if (!isPassthrough(kind)) return true;
  return !PASSTHROUGH_OFF.includes(cap);
}
