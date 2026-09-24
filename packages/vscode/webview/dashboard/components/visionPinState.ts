// The Vision state's READ-OUT LINE — what the popover says vision is, and who
// decided it.
//
// A table, not markup, for the reason visionButtonState.ts beside it is one:
// the rules are four rows and a component is a rendering of them, and a table
// can be checked without a DOM.
//
// SCOPE NARROWED. This file also used to hold WHICH BUTTON was armed and the
// three buttons on offer (Auto/On/Off). Both moved to visionTriad.ts when the
// popover became one control — "which of Auto, On and Profile is the answer"
// depends on the armed profile and on native vision, neither of which is a fact
// about the pin, and threading them through here would have made this table
// answer a question it does not own. What is left is the sentence, which four
// wire values map onto with nothing else in the input.
//
// THE DISTINCTION THE COPY MUST CARRY. `auto-on` and `on` write the same flag
// into origami.json, so nothing downstream can tell them apart — the whole
// point of the pin is that the USER can. "Auto (on — detected)" says the server
// answered and may answer differently tomorrow; "On (pinned)" says the owner
// decided and detection has been told to keep away. Naming both "On" would make
// the pin invisible, which is the state this feature exists to end.
//
// MIRRORED, not shared: `VisionState` is declared here AND in
// src/dashboard/visionPin.ts, because webview code never imports host code at
// runtime. visionPinState.test.ts asserts the two lists still agree.

/** Wire value of `modelStatus.visionState`. Mirror of visionPin.ts's own type. */
export type VisionState = 'auto-on' | 'auto-off' | 'on' | 'off';

const LINES: Record<VisionState, string> = {
  'auto-on': 'Vision: Auto (on — detected)',
  'auto-off': 'Vision: Auto (off)',
  on: 'Vision: On (pinned)',
  off: 'Vision: Off (pinned)',
};

/** The read-out alone — the button's tooltip wants it without the rest. An
 *  unknown wire value reads as plain Auto rather than blank: an older host that
 *  sends no `visionState` at all must not paint an empty line. */
export function visionPinLine(state: VisionState): string {
  return LINES[state] ?? LINES['auto-off'];
}
