// Tweak 3 (0.2.176) — the rotating origami animal shown while a model streams
// its reasoning. These assert the observable contract: while `active` it cycles
// through more than one distinct menagerie glyph; when `active` flips false it
// renders nothing AND tears down its interval (the $effect cleanup runs), so it
// can never keep firing after the thought settles.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup } from '@testing-library/svelte';
import { tick } from 'svelte';
import ThinkingGlyph from './ThinkingGlyph.svelte';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

// Each brand animal is a distinct polygon list, so the first polygon's points
// are a stable signature for "which animal is on screen right now".
function signature(c: HTMLElement): string | null {
  const poly = c.querySelector('svg.am-glyph polygon');
  return poly ? poly.getAttribute('points') : null;
}

describe('ThinkingGlyph — rotating menagerie', () => {
  it('cycles through more than one animal while active', async () => {
    vi.useFakeTimers();
    const { container } = render(ThinkingGlyph, { props: { active: true, interval: 50 } });
    const seen = new Set<string>();
    const first = signature(container);
    expect(first).not.toBeNull();
    seen.add(first!);
    for (let i = 0; i < 6; i++) {
      vi.advanceTimersByTime(50);
      await tick();
      const sig = signature(container);
      if (sig) seen.add(sig);
    }
    // >1 distinct signature proves it actually rotated rather than sitting on a
    // single static glyph.
    expect(seen.size).toBeGreaterThan(1);
  });

  it('stops and tears down its timer when active flips false (no leak, glyph gone)', async () => {
    vi.useFakeTimers();
    const clearSpy = vi.spyOn(globalThis, 'clearInterval');
    const { container, rerender } = render(ThinkingGlyph, { props: { active: true, interval: 50 } });
    expect(signature(container)).not.toBeNull();
    await rerender({ active: false, interval: 50 });
    await tick();
    expect(container.querySelector('svg.am-glyph')).toBeNull();
    expect(clearSpy).toHaveBeenCalled();
  });
});
