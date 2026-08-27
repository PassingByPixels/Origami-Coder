// t-r7c757 — the new-chat empty state's rotating tip. These assert the
// observable contract: a tip renders from the curated list, the interval
// swaps it to the NEXT tip (wrapping the last back to the first — proof it
// is the real rotation, not a random re-roll), and the timer tears down on
// unmount so it can never keep firing after ChatPane's hasConversation gate
// removes this component (the first message ends the empty state forever).

import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup } from '@testing-library/svelte';
import { tick } from 'svelte';
import ChatEmptyState from './ChatEmptyState.svelte';
import { EMPTY_STATE_TIPS, PINNED_SETUP_TIP } from './emptyStateTips';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('ChatEmptyState — online: rotating tip', () => {
  it('renders the crane and the seeded tip from the curated list', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0); // pins the random start to tip 0
    const { container } = render(ChatEmptyState, {
      props: { online: true, providerLocal: true, providerLabel: '', needsSetup: false },
    });
    expect(container.querySelector('.chat-empty-crane svg')).not.toBeNull();
    expect(container.querySelector('.chat-empty-tip')?.textContent).toBe(EMPTY_STATE_TIPS[0]);
  });

  it('advances to the NEXT tip after the interval, wrapping the last tip back to the first', async () => {
    vi.useFakeTimers();
    // Seed just under 1 so the start lands on the LAST tip — the assertion
    // after advancing proves wraparound, not just "some" change.
    vi.spyOn(Math, 'random').mockReturnValue(0.999999);
    const { container } = render(ChatEmptyState, {
      props: { online: true, providerLocal: true, providerLabel: '', needsSetup: false },
    });
    const last = EMPTY_STATE_TIPS.length - 1;
    expect(container.querySelector('.chat-empty-tip')?.textContent).toBe(EMPTY_STATE_TIPS[last]);

    vi.advanceTimersByTime(8000);
    await tick();
    expect(container.querySelector('.chat-empty-tip')?.textContent).toBe(EMPTY_STATE_TIPS[0]);
  });

  it('does not advance before the interval elapses', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const { container } = render(ChatEmptyState, {
      props: { online: true, providerLocal: true, providerLabel: '', needsSetup: false },
    });
    vi.advanceTimersByTime(7000);
    await tick();
    expect(container.querySelector('.chat-empty-tip')?.textContent).toBe(EMPTY_STATE_TIPS[0]);
  });

  it('tears down its timer on unmount (no leak)', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const clearSpy = vi.spyOn(globalThis, 'clearInterval');
    const { unmount } = render(ChatEmptyState, {
      props: { online: true, providerLocal: true, providerLabel: '', needsSetup: false },
    });
    unmount();
    await tick();
    expect(clearSpy).toHaveBeenCalled();
  });
});

describe('ChatEmptyState — offline: setup guidance, no rotation', () => {
  it('shows the local "load a model" hint, not a tip', () => {
    const { container } = render(ChatEmptyState, {
      props: { online: false, providerLocal: true, providerLabel: '', needsSetup: false },
    });
    expect(container.querySelector('.chat-empty-tip')).toBeNull();
    expect(container.textContent).toContain('New here? Load your first model in the Setup panel.');
  });

  it('names the remote provider when unreachable', () => {
    const { container } = render(ChatEmptyState, {
      props: { online: false, providerLocal: false, providerLabel: 'Spark', needsSetup: false },
    });
    expect(container.textContent).toContain('Spark unreachable — check the server.');
  });
});

describe('ChatEmptyState — needsSetup: pinned firstfold tip, no rotation (t-r7c757 round 2)', () => {
  it('renders ONLY the pinned setup tip, overriding online', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const { container } = render(ChatEmptyState, {
      props: { online: true, providerLocal: true, providerLabel: '', needsSetup: true },
    });
    expect(container.querySelector('.chat-empty-tip')?.textContent).toBe(PINNED_SETUP_TIP);
    expect(container.textContent).not.toContain(EMPTY_STATE_TIPS[0]);
  });

  it('overrides the offline guidance too', () => {
    const { container } = render(ChatEmptyState, {
      props: { online: false, providerLocal: true, providerLabel: '', needsSetup: true },
    });
    expect(container.querySelector('.chat-empty-tip')?.textContent).toBe(PINNED_SETUP_TIP);
    expect(container.textContent).not.toContain('New here?');
  });

  it('schedules NO rotation interval — the pinned tip never advances after 8s', async () => {
    vi.useFakeTimers();
    const setSpy = vi.spyOn(globalThis, 'setInterval');
    const { container } = render(ChatEmptyState, {
      props: { online: true, providerLocal: true, providerLabel: '', needsSetup: true },
    });
    expect(setSpy).not.toHaveBeenCalled();

    vi.advanceTimersByTime(8000);
    await tick();
    expect(container.querySelector('.chat-empty-tip')?.textContent).toBe(PINNED_SETUP_TIP);
  });

  it('starts rotating live once needsSetup flips to false, with no reload', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const { container, rerender } = render(ChatEmptyState, {
      props: { online: true, providerLocal: true, providerLabel: '', needsSetup: true },
    });
    expect(container.querySelector('.chat-empty-tip')?.textContent).toBe(PINNED_SETUP_TIP);

    await rerender({ online: true, providerLocal: true, providerLabel: '', needsSetup: false });
    expect(container.querySelector('.chat-empty-tip')?.textContent).toBe(EMPTY_STATE_TIPS[0]);

    vi.advanceTimersByTime(8000);
    await tick();
    expect(container.querySelector('.chat-empty-tip')?.textContent).toBe(EMPTY_STATE_TIPS[1]);
  });
});

// W9 round 2 — A BOT CHAT OPENS UNDER ITS OWN CREATURE.
//
// This is the REPLACEMENT for the editor-tab icon the owner reversed, and the
// reason the replacement is cheap: the tab needed a generated asset per glyph,
// resolved before panel creation, on the one property VS Code will not let you
// change afterwards. Here the same fact is a prop.
//
// Three things can go wrong, and none of them look broken on screen:
//  1. THE CRANE WINS ANYWAY. The prop arrives but nothing swaps, so every bot
//     chat opens under the brand mark and the feature is invisible rather than
//     absent — the exact shape of the failure the tab version shipped with.
//  2. AN ORDINARY CHAT LOSES ITS CRANE. Far worse than 1: the brand mark
//     disappears from the surface it was built for.
//  3. AN UNDRAWN CREATURE DRAWS A LETTER. ArchetypeGlyph's fallback is an
//     initial-letter tile — right in a roster row, and at 56px indistinguishable
//     from a broken image.
//
// The tips are asserted alongside each, because "the glyph replaced the tip"
// would be a silent regression of the feature this component was made for.
describe('ChatEmptyState — a BOT chat opens under its own creature', () => {
  const props = (over: Record<string, unknown> = {}) =>
    ({ online: true, providerLocal: true, providerLabel: '', needsSetup: false, ...over });
  const hero = (c: Element) => c.querySelector('.chat-empty-crane svg');

  it('draws the bot glyph instead of the crane, and keeps the rotating tip', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const { container } = render(ChatEmptyState, { props: props({ botGlyph: 'owl' }) });
    const svg = hero(container)!;
    expect(svg).not.toBeNull();
    // The crane animates (CraneMark carries <animateTransform>); a menagerie
    // glyph is still polygons. That is the cheapest honest tell of WHICH
    // component rendered, and it survives a restyle of either one.
    expect(svg.querySelector('animateTransform')).toBeNull();
    expect(svg.querySelectorAll('polygon').length).toBeGreaterThan(4);
    // ...and the tip is untouched: the glyph says who, the tip says what.
    expect(container.querySelector('.chat-empty-tip')?.textContent).toBe(EMPTY_STATE_TIPS[0]);
  });

  it('still draws the CRANE for an ordinary chat', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const { container } = render(ChatEmptyState, { props: props() });
    expect(hero(container)!.querySelector('animateTransform')).not.toBeNull();
    expect(container.querySelector('.chat-empty-tip')?.textContent).toBe(EMPTY_STATE_TIPS[0]);
  });

  // '' is what a def with no `glyph:` line sends all the way down the wire
  // (botsManager reads `def?.glyph ?? ''`), so it must read as "no creature".
  it('treats an empty glyph as no glyph', () => {
    const { container } = render(ChatEmptyState, { props: props({ botGlyph: '' }) });
    expect(hero(container)!.querySelector('animateTransform')).not.toBeNull();
  });

  // A def naming a creature this build never drew — a hand-edited frontmatter
  // line, or one written by a newer shell. NOT the letter tile.
  it('falls back to the crane for a creature this build does not draw', () => {
    const { container } = render(ChatEmptyState, { props: props({ botGlyph: 'unicorn' }) });
    expect(hero(container)!.querySelector('animateTransform')).not.toBeNull();
    expect(container.querySelector('.am-glyph-tile')).toBeNull();
  });

  // Both marks must land in the SAME slot at the SAME size, or switching
  // between two chats reads as the layout jumping.
  // 56 -> 112 (owner call): the hero is the thing an empty chat is built
  // around, and at 56 a menagerie creature's polygons were too small to tell
  // one animal from another. The number is asserted on BOTH branches in one
  // test because a size that differs by branch is the layout jumping between
  // two chats — the exact failure this shared wrapper exists to stop.
  it('draws the creature at the crane’s size, in the crane’s slot', () => {
    const { container: bot } = render(ChatEmptyState, { props: props({ botGlyph: 'owl' }) });
    const botSvg = hero(bot)!;
    cleanup();
    const { container: plain } = render(ChatEmptyState, { props: props() });
    const craneSvg = hero(plain)!;
    // The crane sets width/height attributes; ArchetypeGlyph sets an inline
    // style. Either way the rendered box is 112px and the wrapper is the same.
    expect(craneSvg.getAttribute('width')).toBe('112');
    expect(craneSvg.getAttribute('height')).toBe('112');
    expect(botSvg.getAttribute('style')).toContain('112px');
    expect(botSvg.getAttribute('viewBox')).toBe(craneSvg.getAttribute('viewBox'));
    expect(botSvg.closest('.chat-empty-crane')).not.toBeNull();
  });

  // The offline and needs-setup branches replace the TIP, never the hero.
  it('keeps the creature through the offline and setup states', () => {
    const { container: off } = render(ChatEmptyState, {
      props: props({ botGlyph: 'owl', online: false, providerLocal: false, providerLabel: 'vLLM' }),
    });
    expect(hero(off)!.querySelector('animateTransform')).toBeNull();
    expect(off.textContent).toContain('vLLM');
    cleanup();
    const { container: setup } = render(ChatEmptyState, { props: props({ botGlyph: 'owl', needsSetup: true }) });
    expect(hero(setup)!.querySelector('animateTransform')).toBeNull();
    expect(setup.querySelector('.chat-empty-tip')?.textContent).toBe(PINNED_SETUP_TIP);
  });
});
