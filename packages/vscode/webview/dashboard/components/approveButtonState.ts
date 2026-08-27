// approveButtonState.ts — what the composer's ONE merged Approve button says
// and how it's coloured, as a pure function of the two settings it now
// speaks for (t-kgsupy round 4). Extracted out of InputBar.svelte (over its
// 1200-line cap once round 4 folded the Browser button into this one) —
// same shape as visionButtonState.ts: a decision should be checkable
// without rendering anything.
//
// The button is named ACCESS to the user (owner UAT): it is the one place both
// access permissions are set, and a label reading "Browser" for a control that
// also holds this chat's own tool approval named the smaller half. Only the
// user-visible strings moved — the two settings, their messages and the
// popover's own "Browser:" ROW keep their names, because that row really is
// VS Code's global browser/tool setting and nothing else.
//
// Both settings' 'bypass' value scores the same (2) on a shared risk scale,
// so the button can show whichever axis is riskier — round 4's own wording
// for what the merged label/colour must reflect — without either setting's
// own state knowing the other axis exists. Both at max risk TOGETHER is a
// WIDER state than either alone (this chat's own bypass AND VS Code's
// all-tools-all-workspaces bypass both live), so it earns its own label
// rather than reading identical to "just this chat is bypassed". Below max
// there is no tie: only 'bypass' scores 2 on either axis, so whichever is
// higher always decides cleanly.
const RISK: Record<string, number> = { default: 0, auto: 1, bypass: 2 };

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

export function approveButtonState(approveMode: string, browserApproveMode: string): ApproveButtonState {
  const actionsRisk = RISK[approveMode] ?? 0;
  const browserRisk = browserApproveMode === 'bypass' ? 2 : 0;
  const label =
    actionsRisk === 2 && browserRisk === 2 ? 'Bypass: All' :
    browserRisk > actionsRisk ? 'Access: Bypass' :
    actionsRisk === 2 ? 'Bypass' :
    actionsRisk === 1 ? 'Auto-approve' :
    'Approve';
  return {
    label,
    active: actionsRisk > 0 || browserRisk > 0,
    bypass: actionsRisk === 2 || browserRisk === 2,
    actionsActive: actionsRisk > 0,
  };
}
