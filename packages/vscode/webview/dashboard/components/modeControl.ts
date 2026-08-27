// The composer's SESSION MODE control, as pure data and pure functions.
//
// Three modes now, not a boolean. Build is ordinary work; Plan is the read-only
// planning agent; Deep Plan researches, argues with itself and DELIVERS a plan
// folder without ever starting on it. The old control was a two-state toggle
// (`isPlan`), and widening a toggle in place is how a third state ends up
// half-wired — so the decisions live here, in one file, with no DOM and no
// `vscode` around them:
//
//   * what the button says for a given engine mode,
//   * which modes are PLANNING modes (the approve rail has nothing to
//     auto-approve in one, and a session-scoped `bypass` preset would override
//     the planning agent's edit boundary outright),
//   * what the popover offers.
//
// The STATE stays in InputBar, which owns the session and does the posting.
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

/**
 * The same three modes in the shape ApproveRail's `Opt` wants, so the popover
 * can draw them as the composer's ONE dot-slider idiom rather than a second,
 * different-looking list of choices.
 *
 * Derived, never re-typed: a fourth mode added above must appear on the rail
 * without anyone remembering a second list. `hint` rides along so the notch
 * tooltip still says what the mode does — the rail's own default would show
 * just the name, and "Deep Plan" alone does not warn you it never builds.
 */
export const MODE_RAIL_OPTIONS: Array<{ value: string; name: string; hint: string }> =
  MODE_OPTIONS.map((option) => ({ value: option.id, name: option.name, hint: option.hint }));

/** The PLANNING modes — the ones where the agent must not edit the project. */
const PLANNING_MODES = new Set(['plan', 'deep-plan']);

/**
 * Is this chat in a planning mode?
 *
 * Used for the approve rail: a read-only agent has nothing to auto-approve, and
 * a session-scoped `bypass` would override the planning agent's own edit denies
 * and break the guarantee the mode is for. Deep plan needs this every bit as
 * much as plan — more so, since its edit boundary is what stops it scaffolding
 * a project it was only asked to think about.
 */
export function isPlanningMode(mode: string): boolean {
  return PLANNING_MODES.has(mode);
}

/**
 * Which of the three the control is showing.
 *
 * Everything unrecognised reads as `build`: the panel starts on the literal
 * string `'default'` before the engine's first `modeOptions` lands, and a chat
 * can be sitting on a user-defined bot agent this control knows nothing about.
 * Neither is a planning mode, and both are safe to draw as the neutral state.
 */
export function modeState(mode: string): string {
  return MODE_IDS.includes(mode) ? mode : 'build';
}

/**
 * The trigger button's label.
 *
 * It stays "Plan" in the neutral state rather than becoming "Mode": the button
 * is where you go to plan, and a control that renames itself to a category
 * tells a first-time reader less than the thing it does. The two ON states name
 * themselves, because the composer's mode is otherwise invisible.
 */
export function modeButtonLabel(mode: string): string {
  switch (modeState(mode)) {
    case 'plan':
      return 'Plan: on';
    case 'deep-plan':
      return 'Deep Plan: on';
    default:
      return 'Plan';
  }
}

/** The trigger button's tooltip: what this control does, plus where it stands. */
export function modeButtonTitle(mode: string): string {
  const current = MODE_OPTIONS.find((option) => option.id === modeState(mode));
  return `Session mode (this chat only) — currently ${current?.name ?? 'Build'}. ${current?.hint ?? ''} Click to change.`;
}
