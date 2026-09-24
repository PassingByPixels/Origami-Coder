// The chat list's entrance. jsdom runs no transition and has no
// IntersectionObserver of its own, so what is provable here is the CONTRACT:
// the reference's threshold, the class the CSS keys off, and the reverse on
// leave. The 200ms/100ms timing is CSS and needs a human eye.
import { describe, expect, it, afterEach, vi } from 'vitest';
import { ANIM_IN_CLASS, ANIM_THRESHOLD, animateIn, resetAnimatedList } from './animatedList';

type Cb = (entries: Array<{ target: Element; isIntersecting: boolean }>) => void;

/** A stand-in for the browser's observer that lets a test drive intersection. */
function stubObserver() {
  const made: Array<{ cb: Cb; options: IntersectionObserverInit; observed: Element[]; unobserved: Element[] }> = [];
  class Stub {
    observed: Element[] = [];
    unobserved: Element[] = [];
    constructor(public cb: Cb, public options: IntersectionObserverInit) {
      made.push(this as never);
    }
    observe(el: Element) { this.observed.push(el); }
    unobserve(el: Element) { this.unobserved.push(el); }
    disconnect() {}
  }
  vi.stubGlobal('IntersectionObserver', Stub as unknown as typeof IntersectionObserver);
  return made;
}

afterEach(() => {
  resetAnimatedList();
  vi.unstubAllGlobals();
});

describe('animateIn', () => {
  it('observes at the reference threshold of 0.5, not on first pixel', () => {
    const made = stubObserver();
    animateIn(document.createElement('div'));
    expect(made).toHaveLength(1);
    expect(made[0].options.threshold).toBe(ANIM_THRESHOLD);
    expect(ANIM_THRESHOLD).toBe(0.5);
  });

  it('shares ONE observer across every row, however many rows there are', () => {
    const made = stubObserver();
    for (let i = 0; i < 40; i++) animateIn(document.createElement('div'));
    expect(made).toHaveLength(1);
    expect(made[0].observed).toHaveLength(40);
  });

  it('adds the class when the row comes into view and REMOVES it when it leaves', () => {
    const made = stubObserver();
    const row = document.createElement('div');
    animateIn(row);
    expect(row.classList.contains(ANIM_IN_CLASS)).toBe(false);

    made[0].cb([{ target: row, isIntersecting: true }]);
    expect(row.classList.contains(ANIM_IN_CLASS)).toBe(true);

    made[0].cb([{ target: row, isIntersecting: false }]);
    expect(row.classList.contains(ANIM_IN_CLASS)).toBe(false);
  });

  it('stops observing a removed row, so a long-lived list does not leak them', () => {
    const made = stubObserver();
    const row = document.createElement('div');
    animateIn(row).destroy?.();
    expect(made[0].unobserved).toEqual([row]);
  });

  it('shows the row at once where there is no IntersectionObserver — never hidden for ever', () => {
    vi.stubGlobal('IntersectionObserver', undefined);
    const row = document.createElement('div');
    animateIn(row);
    expect(row.classList.contains(ANIM_IN_CLASS)).toBe(true);
  });
});
