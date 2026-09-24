// ANIMATED LIST ENTRANCE — react-bits Components/AnimatedList, as written
// (Mock-Redesign/CHANGES.md change 3).
//
// A row starts shrunk and transparent and animates to rest when it becomes
// 50% visible; it REVERSES when it leaves. The reference has no per-index
// stagger, so neither does this: 200 ms with a fixed 100 ms delay, once, for
// every row. (A stagger looks good on a five-row demo and reads as lag on a
// forty-chat sidebar.)
//
// The action only toggles the class. The transition itself belongs to the
// component that WRITES the row markup, because Svelte scopes styles there.
//
// Rows below the fold stay hidden until scrolled to. That is the reference's
// behaviour, and the reason for the no-IntersectionObserver fallback below:
// in jsdom (and in any host without the API) "hidden until seen" would mean
// hidden for ever, so the row is shown at once instead.

export const ANIM_IN_CLASS = 'is-in';
export const ANIM_THRESHOLD = 0.5;

let observer: IntersectionObserver | null = null;

function shared(): IntersectionObserver | null {
  if (typeof IntersectionObserver === 'undefined') return null;
  if (!observer) {
    observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          entry.target.classList.toggle(ANIM_IN_CLASS, entry.isIntersecting);
        }
      },
      { threshold: ANIM_THRESHOLD },
    );
  }
  return observer;
}

/** `use:animateIn` on a list row. */
export function animateIn(node: HTMLElement) {
  const io = shared();
  if (!io) {
    node.classList.add(ANIM_IN_CLASS);
    return {};
  }
  io.observe(node);
  return {
    destroy() {
      io.unobserve(node);
    },
  };
}

/** Tests only: drop the shared observer so each case gets a fresh one. */
export function resetAnimatedList(): void {
  observer?.disconnect();
  observer = null;
}
