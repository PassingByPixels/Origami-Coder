// Tweak 2 — PinnedUserMessage: the compact sticky "You: <text>" mirror shown at
// the top of the transcript while a turn runs. These assert the mirror renders
// the text with a full-text tooltip (so a truncated header is still inspectable),
// and renders NOTHING when there is no user text to pin.

import { render, screen, fireEvent } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import PinnedUserMessage from './PinnedUserMessage.svelte';

describe('PinnedUserMessage — last-message mirror', () => {
  it('renders "You:" + the text, with the full text as a title tooltip', () => {
    const text = 'refactor the auth middleware and add rate limiting';
    const { container } = render(PinnedUserMessage, { props: { text } });
    const pinned = container.querySelector('.pinned-user') as HTMLElement;
    expect(pinned).not.toBeNull();
    expect(pinned.textContent).toContain('You:');
    expect(pinned.textContent).toContain(text);
    // The tooltip carries the untruncated text even when the header ellipsises.
    expect(pinned.getAttribute('data-tip')).toBe(text);
    expect(screen.getByText(text)).toBeInTheDocument();
  });

  it('renders nothing when there is no text to pin', () => {
    const { container } = render(PinnedUserMessage, { props: { text: '' } });
    expect(container.querySelector('.pinned-user')).toBeNull();
  });

  // t-l1soc4 — clicking the pin expands it to the full message; clicking
  // again collapses it back.
  it('is keyboard-reachable and click toggles expanded/collapsed', async () => {
    const text = 'a much longer earlier user message that would normally get ellipsised down to one line';
    const { container } = render(PinnedUserMessage, { props: { text } });
    const pinned = container.querySelector('.pinned-user') as HTMLElement;
    expect(pinned.getAttribute('role')).toBe('button');
    expect(pinned.getAttribute('tabindex')).toBe('0');
    expect(pinned.getAttribute('aria-expanded')).toBe('false');
    expect(pinned.classList.contains('expanded')).toBe(false);

    await fireEvent.click(pinned);
    expect(pinned.getAttribute('aria-expanded')).toBe('true');
    expect(pinned.classList.contains('expanded')).toBe(true);

    await fireEvent.click(pinned);
    expect(pinned.getAttribute('aria-expanded')).toBe('false');
    expect(pinned.classList.contains('expanded')).toBe(false);
  });

  it('Enter/Space on the focused row also toggles expansion', async () => {
    const text = 'another earlier message worth expanding';
    const { container } = render(PinnedUserMessage, { props: { text } });
    const pinned = container.querySelector('.pinned-user') as HTMLElement;

    await fireEvent.keyDown(pinned, { key: 'Enter' });
    expect(pinned.classList.contains('expanded')).toBe(true);

    await fireEvent.keyDown(pinned, { key: ' ' });
    expect(pinned.classList.contains('expanded')).toBe(false);
  });
});
