// approveRowOptions.ts — the Access rail's notches: which supervision levels
// this chat can be put on, and which of them is dead and why.
//
// EXTRACTED from approveButtonState.ts (88 of a 70-line cap) when the
// passthrough rail gained a fourth notch. That file decides what the BUTTON
// says and how it is coloured — a reduction over two settings — and this
// decides what the POPOVER offers, which is a different question with a
// different mirror: the button answers to nothing, while every notch here has
// to have a branch in claudeCodePermissions.modeFromApprove or picking it
// silently does nothing. approveOptions.test.ts reads both files and fails when
// a notch and a mapping fall out of step, in either direction.

/** The Actions notches. On a passthrough the last is DISABLED, not removed: a
 *  rail that silently loses a notch reads as a rendering bug, while a dead notch
 *  with a reason answers "why can I not pick bypass" where it is asked.
 *  claudeCodeManager.modeFromApprove clamps 'bypass' to acceptEdits, so a
 *  selectable notch was promising a mode the harness never enters.
 *
 *  A PASSTHROUGH RAIL LISTS CLAUDE'S OWN MODES (phase 2). The engine's two live
 *  notches are Ask and Auto; the CLI has THREE real supervision levels, and the
 *  middle one — pre-approve edits, keep asking about everything else — is where
 *  most of a session is comfortably spent. Phase 1 folded it away, so the rail
 *  offered a choice between "ask me about every Read" and "answer everything for
 *  me", and the honest middle was unreachable. The values are the CLI's own
 *  names because that is what the user is actually driving here; the MIRROR of
 *  this list is claudeCodeManager.modeFromApprove, and approveOptions.test.ts
 *  reads both files. */
const NO_BYPASS = 'Not available on a Claude Code passthrough chat — the CLI runs under your own permission rules, and Origami has no unsupervised lane to hand it.';
const ACCEPT_EDITS_HINT = 'Claude Code pre-approves file edits. Every other tool still asks.';
export function actionsRowOptions(passthrough: boolean): Array<{ value: string; name: string; hint?: string; disabled?: boolean }> {
  const bypass = passthrough ? { value: 'bypass', name: 'Bypass', disabled: true, hint: NO_BYPASS } : { value: 'bypass', name: 'Bypass' };
  if (!passthrough) return [{ value: 'default', name: 'Ask' }, { value: 'auto', name: 'Auto' }, bypass];
  return [
    { value: 'default', name: 'Ask' },
    { value: 'acceptEdits', name: 'Edits', hint: ACCEPT_EDITS_HINT },
    { value: 'auto', name: 'Auto' },
    bypass,
  ];
}
