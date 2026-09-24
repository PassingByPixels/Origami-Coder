// approveButtonState.ts — what the composer's ONE merged Approve button says
// and how it's coloured, as pure functions of the settings it speaks for
// (t-kgsupy round 4). The rail's NOTCH LIST left for approveRowOptions.ts in
// phase 2, at 88 of a 70-line cap — this header already admitted the two jobs.
// Extracted out of
// InputBar.svelte (over its 1200-line cap once round 4 folded the Browser
// button into this one) — same shape as visionButtonState.ts: a decision should
// be checkable without rendering anything.
//
// The button is named ACCESS to the user (owner UAT): it is the one place both
// access permissions are set, and a label reading "Browser" for a control that
// also holds this chat's own tool approval named the smaller half. Only the
// user-visible strings moved — the two settings, their messages and the
// popover's own "Browser:" ROW keep their names.
//
// Both settings' 'bypass' value scores the same (2) on a shared risk scale,
// so the button can show whichever axis is riskier — round 4's own wording
// for what the merged label/colour must reflect — without either setting's
// own state knowing the other axis exists. Both at max risk TOGETHER is a
// WIDER state than either alone, so it earns its own label rather than reading
// identical to "just this chat is bypassed". Below max there is no tie: only
// 'bypass' scores 2 on either axis, so the higher always decides cleanly.
// `acceptEdits` scores the same as `auto`: both are "something now happens
// without me", which is the step change the button's colour is for. They differ
// in HOW MUCH, and that is what the label says, not what the styling says.
const RISK: Record<string, number> = { default: 0, acceptEdits: 1, auto: 1, bypass: 2 };

// Re-exported so no caller changed an import when the notches moved out.
export { actionsRowOptions } from './approveRowOptions';

export interface ApproveButtonState {
  readonly label: string;
  /** Button should wear the "something is armed" styling — either axis. */
  readonly active: boolean;
  /** Button should wear the red/error styling — either axis at max risk. */
  readonly bypass: boolean;
  /** THIS chat's own Actions preset only, never the global Browser setting —
   *  what the session-mode badge above the composer gates on, so it never
   *  wears a BYPASS badge because some OTHER window turned Browser on. */
  readonly actionsActive: boolean;
}

/** @param passthrough Claude Code cell — where BOTH axes stop being true. It
 *  cannot reach 'bypass' (above), and VS Code's global chat-tool auto-approve
 *  governs VS Code's OWN tools, which a passthrough turn never calls: its tools
 *  run inside the CLI under the CLI's rules. Letting the browser axis colour the
 *  label made the button read "Access: Bypass" on a cell that was in fact asking
 *  about every tool. Riskier-of-two is right for an engine chat, false here. */
export function approveButtonState(approveMode: string, browserApproveMode: string, passthrough = false): ApproveButtonState {
  const actionsRisk = Math.min(RISK[approveMode] ?? 0, passthrough ? 1 : 2);
  const browserRisk = !passthrough && browserApproveMode === 'bypass' ? 2 : 0;
  const label =
    actionsRisk === 2 && browserRisk === 2 ? 'Bypass: All' :
    browserRisk > actionsRisk ? 'Access: Bypass' :
    actionsRisk === 2 ? 'Bypass' :
    actionsRisk === 1 ? (approveMode === 'acceptEdits' ? 'Edits approved' : 'Auto-approve') :
    'Approve';
  return {
    label,
    active: actionsRisk > 0 || browserRisk > 0,
    bypass: actionsRisk === 2 || browserRisk === 2,
    actionsActive: actionsRisk > 0,
  };
}
