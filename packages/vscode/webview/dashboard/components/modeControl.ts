// The composer's session mode control, as pure data and pure functions.
//
// Three modes, not a boolean: Build is ordinary work; Plan is the read-only
// planning agent; Deep Plan researches, argues with itself and delivers a
// plan folder without ever starting on it. The decisions live here, with no
// DOM and no `vscode`: what the button says for a given engine mode, which
// modes are planning modes (the approve rail has nothing to auto-approve in
// one, and a session-scoped `bypass` would override the planning agent's
// edit boundary), and what the popover offers.
//
// The state stays in InputBar, which owns the session and does the posting.
// This module decides nothing and posts nothing.

/** One choice in the mode popover. */
export interface ModeOption {
  /** The engine agent name, exactly as `setMode` / `setConfigOption('mode')` wants it. */
  id: string;
  /** What the popover shows. */
  name: string;
  /** The popover button's tooltip. */
  hint: string;
}

/** The three modes the composer offers, in escalating order of ceremony. */
export const MODE_OPTIONS: ModeOption[] = [
  {
    id: 'build',
    name: 'Build',
    hint: 'Normal working mode — the agent edits files and runs commands.',
  },
  {
    id: 'plan',
    name: 'Plan',
    hint: 'Read-only: the agent researches and writes a plan file, and edits nothing else.',
  },
  {
    id: 'deep-plan',
    name: 'Deep Plan',
    hint: 'For large or new work: researches, drafts, and attacks its own plan, then delivers a plan folder. It never starts building.',
  },
];

/** Just the ids, for a caller that only needs to know what is offered. */
export const MODE_IDS: string[] = MODE_OPTIONS.map((option) => option.id);

/** The same three modes in the shape ApproveRail's `Opt` wants, so the
 *  popover draws them as the composer's one dot-slider idiom. Derived, never
 *  re-typed, so a fourth mode added above appears on the rail automatically;
 *  `hint` rides along so the notch tooltip still says what the mode does. */
export const MODE_RAIL_OPTIONS: Array<{ value: string; name: string; hint: string }> =
  MODE_OPTIONS.map((option) => ({ value: option.id, name: option.name, hint: option.hint }));

/** The PLANNING modes — the ones where the agent must not edit the project. */
const PLANNING_MODES = new Set(['plan', 'deep-plan']);

/** Is this chat in a planning mode? Used for the approve rail: a read-only
 *  agent has nothing to auto-approve, and a session-scoped `bypass` would
 *  override the planning agent's own edit denies. */
export function isPlanningMode(mode: string): boolean {
  return PLANNING_MODES.has(mode);
}

/** Which of the three the control is showing. Everything unrecognised reads
 *  as `build`: the panel starts on the literal string `'default'` before the
 *  engine's first `modeOptions` lands, and both cases are safe to draw as
 *  the neutral state. */
export function modeState(mode: string): string {
  return MODE_IDS.includes(mode) ? mode : 'build';
}

/** The trigger button's label. Stays "Plan" in the neutral state rather than
 *  "Mode": the button is where you go to plan. The two on states name
 *  themselves, since the composer's mode is otherwise invisible. */
export function modeButtonLabel(mode: string, passthrough = false): string {
  switch (modeState(mode)) {
    case 'plan':
      return passthrough ? 'Plan: on — Claude Code' : 'Plan: on';
    case 'deep-plan':
      return passthrough ? 'Plan: on — Claude Code' : 'Deep Plan: on';
    default:
      // Named on a passthrough even when off: on a bound cell this drives
      // Claude's own plan mode, a different guarantee.
      return passthrough ? 'Plan — Claude Code' : 'Plan';
  }
}

/** The trigger button's tooltip: what this control does, plus where it stands. */
export function modeButtonTitle(mode: string): string {
  const current = MODE_OPTIONS.find((option) => option.id === modeState(mode));
  return `Session mode (this chat only) — currently ${current?.name ?? 'Build'}. ${current?.hint ?? ''} Click to change.`;
}
