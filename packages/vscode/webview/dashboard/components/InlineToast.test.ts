// t-qn0wj5, proposal 25 (port of Mock-Redesign CHANGES.md #40's SwipeToast).
import { render, fireEvent, cleanup } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import InlineToast from './InlineToast.svelte';

afterEach(cleanup);

// jsdom has no PointerEvent constructor; a MouseEvent with the same `type`
// string reaches the same addEventListener('pointerdown', ...) handler and
// the component only reads `.clientY`, so this is a faithful stand-in.
function pointerEvent(type: string, clientY: number) {
  return new MouseEvent(type, { clientY, bubbles: true } as MouseEventInit);
}

describe('InlineToast — dismissal', () => {
  it('dismisses on a downward swipe past 40px', async () => {
    const onDismiss = vi.fn();
    const { container } = render(InlineToast, { props: { text: 'Compact density', onDismiss } });
    const toast = container.querySelector('.og-toast')!;
    await fireEvent(toast, pointerEvent('pointerdown', 0));
    await fireEvent(toast, pointerEvent('pointermove', 41));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('does NOT dismiss on a swipe that stays under the threshold', async () => {
    const onDismiss = vi.fn();
    const { container } = render(InlineToast, { props: { text: 'x', onDismiss } });
    const toast = container.querySelector('.og-toast')!;
    await fireEvent(toast, pointerEvent('pointerdown', 0));
    await fireEvent(toast, pointerEvent('pointermove', 30));
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('dismisses when the fuse animation ends (the normal, non-reduced-motion path)', async () => {
    const onDismiss = vi.fn();
    const { container } = render(InlineToast, { props: { text: 'x', onDismiss } });
    const fuse = container.querySelector('.og-toast-fuse')!;
    await fireEvent(fuse, new Event('animationend', { bubbles: true }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('never dismisses twice — a swipe past threshold followed by animationend is one call', async () => {
    const onDismiss = vi.fn();
    const { container } = render(InlineToast, { props: { text: 'x', onDismiss } });
    const toast = container.querySelector('.og-toast')!;
    await fireEvent(toast, pointerEvent('pointerdown', 0));
    await fireEvent(toast, pointerEvent('pointermove', 50));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});

describe('InlineToast — reduced motion', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('renders no fuse element, and still dismisses itself after 4s via a timer', () => {
    const onDismiss = vi.fn();
    const { container } = render(InlineToast, { props: { text: 'x', onDismiss, reducedMotion: true } });
    expect(container.querySelector('.og-toast-fuse')).toBeNull();
    expect(onDismiss).not.toHaveBeenCalled();
    vi.advanceTimersByTime(4000);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('a swipe still dismisses immediately, ahead of the reduced-motion timer', async () => {
    const onDismiss = vi.fn();
    const { container } = render(InlineToast, { props: { text: 'x', onDismiss, reducedMotion: true } });
    const toast = container.querySelector('.og-toast')!;
    await fireEvent(toast, pointerEvent('pointerdown', 0));
    await fireEvent(toast, pointerEvent('pointermove', 50));
    expect(onDismiss).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(4000);
    expect(onDismiss).toHaveBeenCalledTimes(1); // not called a second time by the timer
  });
});
