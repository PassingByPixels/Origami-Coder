// The Vision tri-state, as the composer must SHOW it.
//
// A table, not markup, for the reason visionButtonState.ts beside it is one:
// the rules are four rows and a component is a rendering of them, and a table
// can be checked without a DOM.
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

/** Which of the three buttons is the current answer. */
export type VisionMode = 'auto' | 'on' | 'off';

export interface VisionPinRowState {
  /** The one-line read-out: what vision is, and who decided it. */
  readonly line: string;
  readonly mode: VisionMode;
}

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

export function visionPinState(state: VisionState): VisionPinRowState {
  return {
    line: visionPinLine(state),
    mode: state === 'on' ? 'on' : state === 'off' ? 'off' : 'auto',
  };
}

/** The three choices, in the order they are offered. `wire` is what the host
 *  reads: '' is not a third pin value, it is the ABSENCE of one. */
export const VISION_MODES: readonly { mode: VisionMode; name: string; wire: string; title: string }[] = [
  {
    mode: 'auto',
    name: 'Auto',
    wire: '',
    title: 'Let the server decide. LM Studio and Ollama report which models can see; every other server leaves the setting exactly as configured.',
  },
  {
    mode: 'on',
    name: 'On',
    wire: 'on',
    title: 'This model can read images. Overrules detection until you set it back to Auto.',
  },
  {
    mode: 'off',
    name: 'Off',
    wire: 'off',
    title: 'This model cannot read images. Overrules detection until you set it back to Auto.',
  },
];
