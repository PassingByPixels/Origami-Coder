// t-kgtr6c round 3 — visionButtonState.ts: what the composer's ONE Vision
// button says, and what a click on it opens.
//
// EXTRACTED, not written in place. Round 2 shipped two controls for one subject
// — this button ("Eye") and a separate lit read-out chip — and folding them
// gave the button a third fact to carry, which took VisionProfileMenu.svelte
// from 98 lines to 132 against a cap of 120. The remedy the ratchet prescribes
// is a module, and this is the half that wanted to be one anyway: the rules are
// a table, the component is a rendering, and a table can be checked without a
// DOM.
//
// The one rule worth stating in prose, because it is the whole point of the
// fold: NATIVE WINS. `native` is the webview's copy of the field the engine
// gates on (`capabilities.input.image` — session/vision.ts's `modelSeesImages`,
// reaching here as `isVlm`). When it is true the engine DROPS the profile
// (`activeProfile` returns undefined), so a button that named the armed profile
// there would name a route nothing takes, and a picker offered there would
// offer a setting the engine refuses to spend. The armed profile is still
// reported — it is still set on the session row — but as an idle fact, not as
// a live one.

/** Which of the three popovers a click opens. `picker` is the only one that can
 *  change anything; the other two explain why there is nothing to change. */
export type VisionPop = 'note' | 'empty' | 'picker';

export interface VisionButtonState {
  /** The button's face. Named after the profile only when that profile is live. */
  readonly label: string;
  readonly title: string;
  /** Coloured — for one of two different reasons; `native` tells them apart. */
  readonly lit: boolean;
  readonly pop: VisionPop;
  /** The `note`/`empty` copy. Empty string when the popover is the picker. */
  readonly note: string;
}

export function visionButtonState(input: {
  native: boolean;
  profile: string;
  agents: readonly string[];
}): VisionButtonState {
  if (input.native)
    return {
      label: 'Vision',
      title: 'This model reads attached images itself — there is nothing to arm.',
      lit: true,
      pop: 'note',
      note:
        'This model has native vision — it reads attached images itself.' +
        // Only when a profile IS set: a chat armed before the model was
        // switched keeps the row setting, and the honest thing is to say it is
        // idle rather than leave the user guessing which of the two is in force.
        (input.profile
          ? ` The profile @${input.profile} stays set for this chat and is idle while this model is loaded.`
          : ''),
    };

  if (input.agents.length === 0)
    return {
      label: 'Vision',
      title: 'This model cannot read images, and no vision profiles exist yet.',
      lit: !!input.profile,
      // "None configured" is a different problem from "none chosen", and only
      // one of them is solved by going to the Agents board.
      pop: 'empty',
      note: 'No vision profiles yet. Create one on the Agents board, under Vision Agents.',
    };

  return {
    label: input.profile ? `Vision: ${input.profile}` : 'Vision',
    title: input.profile
      ? `Images this chat cannot see go to @${input.profile} for a description. Click to change or turn off.`
      : 'This model cannot read images. Click to pick an agent that describes them for it.',
    // "On" without a name is the state a user cannot check against the board,
    // so the label carries the slug and the colour only confirms it.
    lit: !!input.profile,
    pop: 'picker',
    note: '',
  };
}
