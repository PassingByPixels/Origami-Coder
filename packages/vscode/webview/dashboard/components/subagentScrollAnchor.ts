// subagentScrollAnchor.ts — the transcript's own "how much arrived while you
// were reading" state, glue only. t-q90v2v (sub-agent chat-pane parity).
//
// Reuses the SAME leaves the main chat pane's scroll anchor uses:
// scrollAnchor.ts (the per-family counts and label), chatScrollRearm.ts (stick
// detection across growth/wheel races) and chatPin.ts (pinning the scroller
// back to its bottom across a few frames). This file holds no counting or
// stick rule of its own — only the small state transitions a Svelte component
// cannot express as a pure import, kept out of SubagentTranscriptView.svelte
// so its addition here does not need to raise that file's cap.

import { rearmOnGrowth, rearmOnScroll } from '../panes/chatScrollRearm';
import { followOnResize, wheelUnsticks } from '../panes/chatScrollInput';
import { noteSeen } from '../panes/chatScrollSeen';
import { isPinning, pinToBottom } from '../panes/chatPin';
import { anchorLabel } from '../panes/scrollAnchor';
import type { Message } from '../panes/chatMessage';

export interface AnchorState {
  stuckToBottom: boolean;
  unseenFromId: number | null;
}

export const initialAnchorState = (): AnchorState => ({ stuckToBottom: true, unseenFromId: null });

/** A scroll event landed on the transcript body. */
export function onAnchorScroll(state: AnchorState, el: Element, lastId: number | null): AnchorState {
  const stuck = rearmOnScroll(el, state.stuckToBottom);
  return { stuckToBottom: stuck, unseenFromId: stuck ? null : (state.unseenFromId ?? lastId) };
}

/** An upward wheel: unsticks only when it moves the transcript (chatScrollInput.ts owns the rule). */
export function onAnchorWheel(state: AnchorState, el: Element, deltaY: number, lastId: number | null, from: EventTarget | null = null): AnchorState {
  if (!wheelUnsticks(el, deltaY, from)) return state;
  return { stuckToBottom: false, unseenFromId: state.unseenFromId ?? lastId };
}

/** The body changed size (t-v47ytt): a follower is pinned, a reader it put on the bottom follows again. */
export const onAnchorResize = (state: AnchorState, el: Element): AnchorState => (followOnResize(el, state.stuckToBottom) ? initialAnchorState() : state);

/** The pill's click: pins the scroller to its bottom and resets the anchor. */
export function jumpToLatest(el: Element): AnchorState {
  pinToBottom(el);
  return initialAnchorState();
}

type Raf = (cb: () => void) => void;
const nextFrame: Raf = (cb) => requestAnimationFrame(cb);

/**
 * A newest-page reply was drawn (open, refresh, running-child poll). A new
 * scroller is at scrollTop 0, which is the OLDEST row of the page, so the first
 * reply must pin; the anchor starts stuck, so it does. A later reply pins only
 * while the reader is stuck, or is back on the bottom they last saw (the main
 * chat's growth re-arm, t-v47ytt): a reader who scrolled up keeps their place.
 * `onPinned` runs when the pin has stopped re-assigning (isPinning is false).
 * Returns the anchor state after the reply, so a re-arm hides the pill.
 */
export function followLatest(el: Element, state: AnchorState, onPinned: () => void, raf: Raf = nextFrame): AnchorState {
  if (!state.stuckToBottom && !rearmOnGrowth(el)) { noteSeen(el); return state; }
  pinToBottom(el, raf);
  const wait = () => (isPinning(el) ? raf(wait) : onPinned());
  raf(wait);
  return initialAnchorState();
}

/** A scroll that is not our own pin's re-assignment counts as the reader's. */
export const readerScrolled = (el: Element): boolean => !isPinning(el);

/** The scroll-up trigger: `onHit` when the sentinel above the first row comes
 *  into view. The observer reports once when it starts, so the caller must
 *  create it only after the pin, or it fires at scrollTop 0 on every open. */
export function watchTop(top: Element, root: Element, onHit: () => void): (() => void) | undefined {
  if (typeof IntersectionObserver === 'undefined') return undefined;
  const io = new IntersectionObserver((hits) => { if (hits.some((hit) => hit.isIntersecting)) onHit(); }, { root });
  io.observe(top);
  return () => io.disconnect();
}

/** "4 files · 2 tools · 5 messages", or '' while stuck (no pill). */
export const anchorPillLabel = (state: AnchorState, messages: readonly Message[]): string =>
  state.stuckToBottom ? '' : anchorLabel(messages, state.unseenFromId);
