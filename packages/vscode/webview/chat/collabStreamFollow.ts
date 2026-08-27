// The collab stream's FOLLOW — the chat's stick rule, wired for one scroller.
//
// THE BUG (report 1.11 / F10). CollabStream.svelte had no scroll logic at all,
// so the running agent's pill — the one live signal a room has — sat below the
// fold on any transcript taller than the pane.
//
// THE RULE IS LIFTED, NOT RE-DERIVED. `chatScroll.ts` already owns "should this
// transcript follow?" and was hardened twice on the traps a naive autoscroll
// walks into: a scrollbar drag whose `scroll` event has not fired yet, growth
// that moves the BOTTOM rather than scrollTop, and a threshold loose enough that
// one arrow-key press re-armed the follow. This file is only the wiring — which
// events feed the rule, and when the stream is told to catch up — so the two
// surfaces can never drift apart on the decision itself.
//
// A CONTROLLER, not a component method: CollabStream.svelte is 2 lines under its
// architecture cap, and a rule nobody can test is a rule nobody can trust.
import { dropScrollAnchor, isNearBottom, markScrollAnchor, stickToBottom } from '../dashboard/panes/chatScroll';

export interface StreamFollow {
  /** The scroller to follow. `null` while the pane is between renders. */
  bind(el: Element | null): void;
  /** A scroll landed — re-read the stick from where the scroller actually IS.
   *  This also runs for our OWN programmatic scroll, which lands at the bottom
   *  and so re-arms the follow rather than fighting it. */
  onScroll(): void;
  /** Upward wheel intent, read BEFORE the first movement clears the threshold. */
  onWheel(deltaY: number): void;
  /**
   * Catch the stream up, unless the user has moved away.
   *
   * `newestSeq` + `byHuman` describe the newest message: the user's own post is
   * an explicit "I want to watch this" and outranks a position we inferred, the
   * same call ChatPane's send makes. It re-arms ONCE per message — the newest
   * message stays the human's until an agent answers, which can be minutes, and
   * re-arming through that whole window would defeat the stick exactly while
   * they read back over what they asked for.
   */
  follow(newestSeq?: number, byHuman?: boolean): void;
}

export function makeStreamFollow(
  // Deferred to the next rendering opportunity, like ChatPane's: a message
  // landing just before the user scrolls away would otherwise leave a snap in
  // flight that fires after their scroll.
  frame: (fn: () => void) => void = (fn) => { requestAnimationFrame(fn); },
): StreamFollow {
  let el: Element | null = null;
  /** Undefined-means-follow, exactly as a fresh chat session starts. */
  let stuck = true;
  /** The seq the follow was last re-armed on, so one post re-arms once. */
  let armedAt = 0;

  return {
    bind(node) { el = node; },
    onScroll() {
      if (!el) return;
      markScrollAnchor(el);
      stuck = isNearBottom(el.scrollTop, el.scrollHeight, el.clientHeight);
    },
    onWheel(deltaY) { if (deltaY < 0) stuck = false; },
    follow(newestSeq = 0, byHuman = false) {
      if (byHuman && newestSeq > armedAt) {
        armedAt = newestSeq;
        stuck = true;
        // A stated intent outranks one inferred from a position — drop the
        // anchor too, or the last one still reads as "the user moved".
        if (el) dropScrollAnchor(el);
      }
      frame(() => {
        if (!el || !stuck) return;
        if (!stickToBottom(el)) stuck = false;
      });
    },
  };
}
