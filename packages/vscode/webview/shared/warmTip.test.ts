// The warm tooltip's three timings and its placement. What makes a dock feel
// like one control rather than seven is the WARM WINDOW — travel between two
// items and the label swaps at once, with no second fuse — so that is what is
// asserted here, not "a tooltip element exists".
//
// Placement is pure arithmetic on a rect, which is the only way to test it:
// jsdom has no layout, so every getBoundingClientRect in the real component
// reports zeros.
import { describe, expect, it, vi, afterEach } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/svelte';
import { tick } from 'svelte';
import WarmTooltip from './WarmTooltip.svelte';
import { TIP_FUSE, TIP_GRACE, TIP_WARM, fuseDelay, isWideLabel, resetTipState, tip } from './warmTip';
import { anchoredPlacement, tipPlacement } from './tipPlace';

afterEach(() => {
  cleanup();
  resetTipState();
  vi.useRealTimers();
});

describe('warmTip — the fuse and the warm window', () => {
  it('a first hover waits out the fuse, so a stray pass shows nothing', () => {
    expect(fuseDelay(1000, false, 0)).toBe(TIP_FUSE);
  });

  it('a tip already open opens the next one with NO fuse', () => {
    expect(fuseDelay(1000, true, 0)).toBe(0);
  });

  it('the group stays warm briefly after a tip closes, then goes cold again', () => {
    const closedAt = 1000;
    expect(fuseDelay(closedAt + TIP_WARM - 1, false, closedAt + TIP_WARM)).toBe(0);
    expect(fuseDelay(closedAt + TIP_WARM, false, closedAt + TIP_WARM)).toBe(TIP_FUSE);
  });
});

describe('warmTip — placement', () => {
  const rect = (top: number, height = 30) => ({ left: 100, top, bottom: top + height, width: 30 });

  it('sits below the control and centres on it', () => {
    const p = tipPlacement(rect(100), 80, 24, 1000, 800);
    expect(p.above).toBe(false);
    expect(p.y).toBe(138);
    expect(p.x).toBe(115);
  });

  it('flips above when the box would run off the bottom — the composer case', () => {
    const p = tipPlacement(rect(750), 80, 24, 1000, 800);
    expect(p.above).toBe(true);
    expect(p.y).toBe(750 - 8 - 24);
  });

  it('does NOT flip when there is no room above either — off-screen beats cramped', () => {
    const p = tipPlacement(rect(0, 790), 80, 24, 1000, 800);
    expect(p.above).toBe(false);
  });

  it('clamps to the viewport, so a control at either edge still gets a whole box', () => {
    expect(tipPlacement({ left: 0, top: 10, bottom: 40, width: 20 }, 200, 24, 1000, 800).x).toBe(104);
    expect(tipPlacement({ left: 980, top: 10, bottom: 40, width: 20 }, 200, 24, 1000, 800).x).toBe(896);
  });

  it('long or multi-line labels take the wide box', () => {
    expect(isWideLabel('Manager')).toBe(false);
    expect(isWideLabel('a'.repeat(35))).toBe(true);
    expect(isWideLabel('two\nlines')).toBe(true);
  });
});

describe('WarmTooltip — the single shared box', () => {
  /** A host control with the action bound, the way a dock item binds it. */
  function mount(label: string) {
    const host = document.createElement('button');
    document.body.appendChild(host);
    const handle = tip(host, label);
    return { host, handle };
  }

  it('shows the hovered control\'s label after the fuse, and only then', async () => {
    vi.useFakeTimers();
    const { container } = render(WarmTooltip);
    const box = container.querySelector('.og-tip')!;
    const { host, handle } = mount('Chat history');

    await fireEvent.mouseEnter(host);
    expect(box.classList.contains('is-in')).toBe(false);

    vi.advanceTimersByTime(TIP_FUSE);
    await tick();
    expect(box.textContent).toBe('Chat history');
    expect(box.classList.contains('is-in')).toBe(true);

    handle.destroy();
    host.remove();
  });

  it('swaps the label at once when the pointer travels to a second control', async () => {
    vi.useFakeTimers();
    const { container } = render(WarmTooltip);
    const box = container.querySelector('.og-tip')!;
    const a = mount('Chat history');
    const b = mount('Manager');

    await fireEvent.mouseEnter(a.host);
    vi.advanceTimersByTime(TIP_FUSE);
    await tick();
    await fireEvent.mouseLeave(a.host);
    await fireEvent.mouseEnter(b.host);
    // No fuse advanced here at all: the group is warm, so the swap is instant.
    vi.advanceTimersByTime(0);
    await tick();

    expect(box.textContent).toBe('Manager');
    expect(box.classList.contains('is-in')).toBe(true);

    a.handle.destroy(); b.handle.destroy();
    a.host.remove(); b.host.remove();
  });

  it('closes after the grace once the pointer has left for good', async () => {
    vi.useFakeTimers();
    const { container } = render(WarmTooltip);
    const box = container.querySelector('.og-tip')!;
    const { host, handle } = mount('Manager');

    await fireEvent.mouseEnter(host);
    vi.advanceTimersByTime(TIP_FUSE);
    await tick();
    await fireEvent.mouseLeave(host);
    vi.advanceTimersByTime(TIP_GRACE);
    await tick();

    expect(box.classList.contains('is-in')).toBe(false);

    handle.destroy();
    host.remove();
  });

  it('opens at once on keyboard focus — a fuse there would mean tabbing shows nothing', async () => {
    const { container } = render(WarmTooltip);
    const box = container.querySelector('.og-tip')!;
    const { host, handle } = mount('New chat');

    await fireEvent.focus(host);
    await tick();
    expect(box.textContent).toBe('New chat');

    handle.destroy();
    host.remove();
  });

  it('an empty label opens nothing, so a control can opt out', async () => {
    vi.useFakeTimers();
    const { container } = render(WarmTooltip);
    const box = container.querySelector('.og-tip')!;
    const { host, handle } = mount('');

    await fireEvent.mouseEnter(host);
    vi.advanceTimersByTime(TIP_FUSE * 4);
    await tick();
    expect(box.classList.contains('is-in')).toBe(false);

    handle.destroy();
    host.remove();
  });
});

// A card on a COMPOSER control lines up with the composer, not with the 20px
// control it hangs off (CHANGES.md round 3, change 55).
describe('tipPlace — anchored to the composer', () => {
  const composer = { left: 100, right: 500, top: 600 };

  it('lands the box right edge on the composer gutter', () => {
    const p = anchoredPlacement(composer, 200, 120);
    // x is a CENTRE (the box is translate(-50%)), so the right edge is x + w/2.
    expect(p.x + 100).toBe(500 - 12);
    expect(p.above).toBe(true);
  });

  it('caps the box to the composer inner measure', () => {
    expect(anchoredPlacement(composer, 900, 120).maxWidth).toBe(400 - 24);
    // …and a box already narrower than the measure is not stretched.
    expect(anchoredPlacement(composer, 200, 120).maxWidth).toBe(376);
  });

  it('a wider box than the composer still ends on the gutter, not past it', () => {
    const p = anchoredPlacement(composer, 900, 120);
    expect(p.x + 376 / 2).toBe(488);
  });

  it('sits ABOVE the composer — it is at the foot of the pane', () => {
    expect(anchoredPlacement(composer, 200, 120).y).toBe(600 - 8 - 120);
  });
});
