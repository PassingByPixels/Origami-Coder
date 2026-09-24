// subagentAutoOpen.ts — when the sub-agent drawer opens ITSELF (t-ru13hb item 3).
//
// The drawer boots shut and its row list boots collapsed, both deliberately: a
// background roster is something to consult, not something that should cover
// the reply being read. The cost was that a fan-out could be running with
// nothing on screen saying so — the one thing the drawer exists to prevent.
//
// So: a child going out reveals the roster once. And exactly once, because the
// second rule matters as much as the first — DO NOT FIGHT THE USER. Somebody
// who shuts the drawer or collapses the list has said what they want, and the
// next spawn must not undo it. That flag lasts as long as the surface does.
//
// A LEAF because SubagentDrawer.svelte is a capped file and this is a rule with
// two halves that are easy to get backwards.

/**
 * A child just went out: reveal the roster?
 *
 * `running` is the RUNNING BAND's size (queued rows included — a queued child
 * is out, it simply has not started), compared with what it was on the last
 * pass. A GROWTH is the trigger, not "> 0": a drawer the user shut with three
 * agents out must stay shut while those same three keep running, and reopen
 * only if they act again.
 */
export function shouldReveal(prevRunning: number, running: number, collapsedByUser: boolean): boolean {
  return !collapsedByUser && running > prevRunning;
}

/**
 * Put the first running row where it can be read. `block: 'nearest'` and not
 * `'start'`: the list is a 220px scroll box inside a floating panel, and a
 * stronger alignment scrolls the CHAT behind it as well.
 *
 * Nothing here asserts it worked — jsdom has no layout and no `scrollIntoView`
 * at all (WORKING_ON_ORIGAMI_CODER.md Part 6), which is why the call is
 * guarded and why the test spies on it rather than measuring a rect.
 */
export function revealFirstRunning(listRoot: HTMLElement | null): void {
  const first = listRoot?.querySelector('.sa-group .sa-list')?.firstElementChild;
  (first as HTMLElement | undefined)?.scrollIntoView?.({ block: 'nearest' });
}

/** The rule with its two counters, so a capped component holds neither. */
export interface Reveal {
  /** The running band's size on this pass: true if the roster should show. */
  arrived(running: number): boolean;
  /** The user shut the drawer or folded the list — nothing reveals it again. */
  stop(): void;
}

export function createReveal(): Reveal {
  let prev = 0;
  let collapsedByUser = false;
  return {
    arrived(running) {
      const yes = shouldReveal(prev, running, collapsedByUser);
      prev = running;
      return yes;
    },
    stop() { collapsedByUser = true; },
  };
}
