// secondOpinionCard.ts — WHAT the second-opinion card may offer, per state.
//
// The .ts-decides half of SecondOpinionCard.svelte, extracted for the 0.4.66
// UAT defect this rule now closes: after "Hand chat to X" the card KEPT both
// buttons, so accept could be clicked twice and dismissed after accepting. The
// two outcomes are terminal and mutually exclusive, and that is exactly the
// kind of rule a rendered test proves weakly (a button missing for an
// unrelated reason passes the same query) — so it is a pure function asserted
// with nothing rendered, like secondOpinionModels.ts beside it.

import type { SecondOpinionInfo } from '../panes/chatMessage';

/** Which of the card's two actions are offered. Empty is a real state: a
 *  resolved card offers NOTHING — that is the fix, not an omission. */
export interface CardActions {
  hand: boolean;
  dismiss: boolean;
}

/**
 * The action rail for one card.
 *
 * THE RULE THAT MATTERS: any `resolution` kills BOTH actions. Accept and
 * dismiss are terminal — once either fires, a second click of either must be
 * impossible, and that must survive a re-render (the resolution lives on the
 * message, chatMessage.ts, not in component state).
 */
export function cardActions(
  state: SecondOpinionInfo['state'],
  resolution: SecondOpinionInfo['resolution'],
  readOnly: boolean,
): CardActions {
  if (resolution) return { hand: false, dismiss: false };
  if (state === 'pending') return { hand: false, dismiss: false };
  // Hand-over changes a LIVE session's model, so history kills it (the same
  // rule that hides Rewind there). Dismiss stays: collapsing acts on nothing.
  return { hand: state === 'ok' && !readOnly, dismiss: true };
}

/** Elapsed seconds as "mm:ss" for the pending ticker. Minutes keep counting
 *  past 59 ("75:03") — wrapping to zero would say a stuck review restarted. */
export function formatElapsed(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  const mm = String(Math.floor(whole / 60)).padStart(2, '0');
  const ss = String(whole % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}
