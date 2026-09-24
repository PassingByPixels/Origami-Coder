// The Vision control as one question: Auto, On, or Profile.
//
// The popover used to stack two unrelated features — the per-model
// capability pin (Auto/On/Off) on top of the per-chat vision-profile list
// (Off/@slug) — and both could draw an armed row, showing two contradictory
// answers at once. The fix decides there is one question, "how does this
// chat get to see a picture?", with exactly one answer at a time.
//
// The answers aren't the same kind of thing: Auto and On are the pin, per
// model, in force in every chat that loads it (visionPin.ts); Profile is a
// vision agent armed on the session row, per chat, surviving a model switch
// (session/vision.ts). Every choice carries the scope it acts on as its own sublabel.
//
// A table, not markup: eight combinations of (state x profile x native) is
// more than a component test wants to enumerate through a DOM.
//
// Native wins: when `native` (the webview's copy of `capabilities.input.image`)
// is true the engine drops the profile, so the choice is withheld, not
// merely unlit.
//
// Legacy 'off': nothing offers pinning "this model cannot see" any more, but
// pins already stored are still obeyed and shown as a dead chip, because
// silently ignoring a stored choice is worse than retiring the button.

import { visionPinLine, type VisionState } from './visionPinState';

/** The four things the control can be showing as the current answer. `off` is
 *  the legacy pin only — it is never offered, only reported. */
export type TriadMode = 'auto' | 'on' | 'profile' | 'off';

export interface TriadChoice {
  readonly mode: TriadMode;
  readonly name: string;
  /** What `setVisionPin` is posted with. `undefined` = this choice writes no
   *  pin at all; '' is the absence of one, not a third pin value. */
  readonly wire: string | undefined;
  /** Which scope the choice acts on, rendered since the two halves of this
   *  control have different lifetimes. */
  readonly scope: string;
  readonly title: string;
}

/** The choices offered, in order. NO Off: see the header. */
export const TRIAD_CHOICES: readonly TriadChoice[] = [
  {
    mode: 'auto',
    name: 'Auto',
    wire: '',
    scope: 'this model',
    title:
      'Let the server decide. LM Studio and Ollama report which models can see; every other server leaves the setting exactly as configured.',
  },
  {
    mode: 'on',
    name: 'On',
    wire: 'on',
    scope: 'this model',
    title:
      'This model can read images. Overrules detection until you set it back to Auto, and applies from your next message.',
  },
  {
    mode: 'profile',
    name: 'Profile',
    wire: undefined,
    scope: 'this chat',
    title:
      'Images this chat cannot see go to a sighted agent for a description. Set for this chat only — the model keeps whatever Auto or On says.',
  },
];

export interface TriadState {
  /** The read-out: what vision is, and who decided it. */
  readonly line: string;
  /** EXACTLY ONE. Every render asserts this — two lit answers is the defect. */
  readonly active: TriadMode;
  /** What the engine currently believes, under the Auto choice. */
  readonly autoNote: string;
  /** Profile is offered only when profiles exist AND the model is not native. */
  readonly showProfile: boolean;
  /** The retired 'off' pin, still stored, still obeyed. */
  readonly showLegacyOff: boolean;
}

/** What the Auto choice says the engine currently thinks. A pinned model's
 *  detected answer isn't knowable from here, so Auto offers to ask again
 *  rather than reporting a number it doesn't have. */
function autoNoteFor(vision: VisionState): string {
  if (vision === 'auto-on') return 'detected: vision';
  if (vision === 'on' || vision === 'off') return 'let the server decide again';
  return 'no vision detected';
}

/** Which single choice is the current answer — the route the next message
 *  takes. Order matters: a pin of 'on' wins outright (the engine drops any
 *  armed profile); otherwise an armed profile is the route, including for a
 *  model pinned 'off'; a bare legacy 'off' with nothing routed reports
 *  itself; everything else is Auto. */
export function visionTriad(input: {
  vision: VisionState;
  profile: string;
  agents: readonly string[];
  native: boolean;
}): TriadState {
  const showProfile = input.agents.length > 0 && !input.native;
  const active: TriadMode =
    input.vision === 'on' ? 'on'
    : showProfile && !!input.profile ? 'profile'
    : input.vision === 'off' ? 'off'
    : 'auto';
  return {
    line: visionPinLine(input.vision),
    active,
    autoNote: autoNoteFor(input.vision),
    showProfile,
    showLegacyOff: input.vision === 'off',
  };
}
