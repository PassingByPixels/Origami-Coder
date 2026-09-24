// SecondOpinionCard — the transcript row a review lands in, and the pure
// action rules beside it (secondOpinionCard.ts — one test file for the pair,
// the ChatFind.test.ts precedent).
//
// Structure, text and wire only. `vitest.config.mts` does not set `css: true`,
// so no <style> element ever reaches this DOM and getComputedStyle answers ''
// for everything: whether the accent edge reads as a judgement rather than
// another bubble is a question for a human eye. What IS checkable here is the
// thing that would be worst to get wrong — that the ACTION the card exists for
// posts the right message to the right chat, that it is not offered in the two
// states where it would be a lie (still pending, or the review failed), and
// that ACCEPT IS TERMINAL: the 0.4.66 UAT defect was accept leaving both
// buttons clickable, so the proof here is that no second click can exist —
// including after a full unmount/remount, which is exactly the re-render that
// used to resurrect them.

import { render, fireEvent, cleanup } from '@testing-library/svelte';
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { tick } from 'svelte';
import SecondOpinionCard from './SecondOpinionCard.svelte';
import { cardActions, formatElapsed } from './secondOpinionCard';
import type { SecondOpinionInfo } from '../panes/chatMessage';

const post = () => globalThis.__vscodeApiMock.postMessage;

const info = (over: Partial<SecondOpinionInfo> = {}): SecondOpinionInfo => ({
  id: 'so-1',
  modelId: 'openrouter/anthropic/claude-sonnet-4',
  modelLabel: 'Claude Sonnet 4',
  state: 'ok',
  ...over,
});

const draw = (over: Partial<SecondOpinionInfo> = {}, props: Record<string, unknown> = {}) =>
  render(SecondOpinionCard, {
    info: info(over),
    text: 'The bound is still wrong.\n\nVerdict: **CONCERNS**',
    sessionId: 'chat-7',
    ...props,
  });

beforeEach(() => post().mockReset());
afterEach(() => cleanup());

describe('cardActions — the terminal-and-exclusive rule, pure', () => {
  it('offers both actions on a live OK review, and only dismiss on error/read-only', () => {
    expect(cardActions('ok', undefined, false)).toEqual({ hand: true, dismiss: true });
    expect(cardActions('ok', undefined, true)).toEqual({ hand: false, dismiss: true });
    expect(cardActions('error', undefined, false)).toEqual({ hand: false, dismiss: true });
    expect(cardActions('pending', undefined, false)).toEqual({ hand: false, dismiss: false });
  });

  it('offers NOTHING once either outcome fired — accept and dismiss are terminal', () => {
    for (const state of ['ok', 'error', 'pending'] as const) {
      expect(cardActions(state, 'handed', false)).toEqual({ hand: false, dismiss: false });
      expect(cardActions(state, 'dismissed', false)).toEqual({ hand: false, dismiss: false });
    }
  });

  it('formats elapsed seconds as mm:ss, minutes running past the hour rather than wrapping', () => {
    expect(formatElapsed(0)).toBe('00:00');
    expect(formatElapsed(65)).toBe('01:05');
    expect(formatElapsed(3599)).toBe('59:59');
    expect(formatElapsed(4515)).toBe('75:15');
  });
});

describe('the three states each say what is happening', () => {
  it('PENDING names the model, says what actually runs, and shows no actions', () => {
    const { container } = draw({ state: 'pending' });
    expect(container.querySelector('.so-chip')!.textContent).toContain('Claude Sonnet 4');
    expect(container.querySelector('.so-wait')!.textContent).toContain('is reviewing the last turn');
    // The honest description — one tool-less generation, not a sub-agent.
    expect(container.querySelector('.so-sub')!.textContent).toContain('single review pass, no tools');
    // No rail: there is nothing to hand over or dismiss until an answer lands.
    expect(container.querySelector('.so-actions')).toBeNull();
  });

  it('PENDING ticks an elapsed mm:ss clock, torn down with the card', async () => {
    vi.useFakeTimers();
    try {
      const { container, unmount } = draw({ state: 'pending' });
      await tick();
      expect(container.querySelector('.so-elapsed')!.textContent).toBe('00:00');

      vi.advanceTimersByTime(65_000);
      await tick();
      expect(container.querySelector('.so-elapsed')!.textContent).toBe('01:05');

      unmount();
      // The cleanup proof: an interval outliving its card would tick a dead
      // DOM forever, once per card per review.
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops the clock the moment the answer lands', async () => {
    vi.useFakeTimers();
    try {
      const { rerender } = draw({ state: 'pending' });
      await tick();
      expect(vi.getTimerCount()).toBe(1);
      await rerender({ info: info({ state: 'ok' }) });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('OK renders the review body as markdown, through the transcript’s own renderer', () => {
    const { container } = draw({ state: 'ok' });
    // A second renderer here would drift from MessageRow in silence, so the
    // proof is that markdown was actually PARSED — `**CONCERNS**` reaching the
    // DOM as literal asterisks is exactly what a plain-text fallback looks like.
    expect(container.querySelector('.so-chip')).toBeNull();
    expect(container.querySelector('strong')!.textContent).toBe('CONCERNS');
    expect(container.textContent).not.toContain('**CONCERNS**');
  });

  it('ERROR shows the failure wording verbatim and NOT the empty body', () => {
    const { container } = draw({ state: 'error', error: 'lmstudio refused: model not loaded' }, { text: '' });
    expect(container.querySelector('.so-failed')!.textContent).toContain('lmstudio refused: model not loaded');
    expect(container.querySelector('.so-card')!.classList.contains('failed')).toBe(true);
  });

  it('ERROR still says something when the host sent no wording at all', () => {
    const { container } = draw({ state: 'error' }, { text: '' });
    expect(container.querySelector('.so-failed')!.textContent!.trim().length).toBeGreaterThan(0);
  });

  it('names the reviewing model in every state — the card is worthless unlabelled', () => {
    for (const state of ['pending', 'error'] as const) {
      const { container } = draw({ state, error: 'x' }, { text: '' });
      expect(container.textContent).toContain('Claude Sonnet 4');
      cleanup();
    }
    const ok = draw({ state: 'ok' }).container;
    expect(ok.textContent).toContain('Claude Sonnet 4');
  });
});

describe('handing the chat over — the decision the card exists for', () => {
  it('posts the EXISTING setModel message, for the posting chat and the reviewing model', () => {
    const { container } = draw({ state: 'ok' });
    fireEvent.click(container.querySelector('.so-hand')!);
    // Deliberately the picker's own wire: the engine must see one kind of model
    // switch, not a second path that drifts from it.
    expect(post()).toHaveBeenCalledWith({
      type: 'setModel',
      modelId: 'openrouter/anthropic/claude-sonnet-4',
      sessionId: 'chat-7',
    });
  });

  it('is NOT offered while the review is still pending', () => {
    expect(draw({ state: 'pending' }).container.querySelector('.so-hand')).toBeNull();
  });

  it('is NOT offered when the review failed — there is no opinion to act on', () => {
    const { container } = draw({ state: 'error', error: 'timed out' }, { text: '' });
    expect(container.querySelector('.so-hand')).toBeNull();
    // Dismiss survives: collapsing a row acts on nothing.
    expect(container.querySelector('.so-dismiss')).not.toBeNull();
  });

  it('is NOT offered on a read-only transcript, which has no live session to switch', () => {
    const { container } = draw({ state: 'ok' }, { readOnly: true });
    expect(container.querySelector('.so-hand')).toBeNull();
    expect(container.querySelector('.so-dismiss')).not.toBeNull();
  });
});

describe('accept is TERMINAL — the 0.4.66 UAT defect', () => {
  it('collapses to a "Handed to" one-liner and removes BOTH actions — a second click cannot exist', async () => {
    const { container } = draw({ state: 'ok' });
    await fireEvent.click(container.querySelector('.so-hand')!);
    await tick();

    // The defect was exactly this pair surviving the click.
    expect(container.querySelector('.so-hand')).toBeNull();
    expect(container.querySelector('.so-dismiss')).toBeNull();
    expect(container.querySelector('.so-actions')).toBeNull();
    expect(container.querySelector('.so-handed')!.textContent).toContain('Handed to Claude Sonnet 4');
    // Exactly one switch went over the wire.
    expect(post()).toHaveBeenCalledTimes(1);
  });

  it('keeps the opinion readable — the stub expands to the review, still with no actions', async () => {
    const { container } = draw({ state: 'ok' });
    await fireEvent.click(container.querySelector('.so-hand')!);
    await tick();

    await fireEvent.click(container.querySelector('.so-handed')!);
    await tick();
    expect(container.querySelector('strong')!.textContent).toBe('CONCERNS');
    expect(container.querySelector('.so-hand')).toBeNull();
    expect(container.querySelector('.so-dismiss')).toBeNull();

    // ...and folds back up.
    await fireEvent.click(container.querySelector('.so-handed')!);
    await tick();
    expect(container.querySelector('strong')).toBeNull();
  });

  it('writes the resolution ONTO THE MESSAGE, so a re-render cannot resurrect the buttons', async () => {
    // The same info object across two mounts stands in for the pane re-rendering
    // its transcript: component state dies with the unmount, the message row
    // does not — and the row is where the answer must live.
    const shared = info({ state: 'ok' });
    const first = render(SecondOpinionCard, { info: shared, text: 'body', sessionId: 'chat-7' });
    await fireEvent.click(first.container.querySelector('.so-hand')!);
    expect(shared.resolution).toBe('handed');
    first.unmount();

    const second = render(SecondOpinionCard, { info: shared, text: 'body', sessionId: 'chat-7' });
    await tick();
    expect(second.container.querySelector('.so-hand')).toBeNull();
    expect(second.container.querySelector('.so-dismiss')).toBeNull();
    expect(second.container.querySelector('.so-handed')!.textContent).toContain('Handed to Claude Sonnet 4');
  });
});

describe('dismiss is local, reversible and silent', () => {
  it('collapses the card to a one-line stub', async () => {
    const { container } = draw({ state: 'ok' });
    await fireEvent.click(container.querySelector('.so-dismiss')!);
    await tick();
    expect(container.querySelector('.so-card')).toBeNull();
    expect(container.querySelector('.so-stub')!.textContent).toContain('Claude Sonnet 4');
  });

  it('survives a re-render collapsed, like accept does', async () => {
    const shared = info({ state: 'ok' });
    const first = render(SecondOpinionCard, { info: shared, text: 'body', sessionId: 'chat-7' });
    await fireEvent.click(first.container.querySelector('.so-dismiss')!);
    expect(shared.resolution).toBe('dismissed');
    first.unmount();

    const second = render(SecondOpinionCard, { info: shared, text: 'body', sessionId: 'chat-7' });
    await tick();
    expect(second.container.querySelector('.so-card')).toBeNull();
    expect(second.container.querySelector('.so-stub')).not.toBeNull();
  });

  it('brings the review back when the stub is clicked — a review must not be losable', async () => {
    const shared = info({ state: 'ok' });
    const { container } = render(SecondOpinionCard, {
      info: shared,
      text: 'Verdict: **CONCERNS**',
      sessionId: 'chat-7',
    });
    await fireEvent.click(container.querySelector('.so-dismiss')!);
    await tick();
    await fireEvent.click(container.querySelector('.so-stub')!);
    await tick();
    expect(container.querySelector('.so-card')).not.toBeNull();
    expect(container.querySelector('strong')!.textContent).toBe('CONCERNS');
    // Reopening UNDOES the dismissal on the message too — otherwise the next
    // re-render would collapse a card the user just chose to read.
    expect(shared.resolution).toBeUndefined();
  });

  it('sends nothing over the wire — the transcript is history, not a host action', async () => {
    const { container } = draw({ state: 'ok' });
    await fireEvent.click(container.querySelector('.so-dismiss')!);
    expect(post()).not.toHaveBeenCalled();
  });
});
