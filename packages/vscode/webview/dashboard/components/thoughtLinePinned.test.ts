// t-qmzegs item 4 — the live thought row carries a ThoughtLine that SETTLES
// when the text lands, and the pinned prompt bar is a fade with no box that
// still expands on click.
//
// Animation itself is a browser fact and is not claimed here: jsdom runs no
// transitions and this suite loads no <style>. What is decidable is the STATE
// the CSS hangs off — which class is on the indicator — and, for the fade, what
// the component actually ships, read out of its own source.
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import PinnedUserMessage from './PinnedUserMessage.svelte';
import ThoughtLine from './ThoughtLine.svelte';
import ThoughtPill from './ThoughtPill.svelte';

afterEach(cleanup);

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (f: string) => readFileSync(path.join(here, f), 'utf8').replace(/\r\n/g, '\n');

describe('change 22 — the thought row moves while the model thinks, and settles when it stops', () => {
  it('a LIVE thought marks both the label and the line as working', () => {
    const { container } = render(ThoughtPill, { text: 'hmm', label: 'Thought process', live: true });
    expect(container.querySelector('.thought-label.working')).not.toBeNull();
    expect(container.querySelector('.tl-line.working')).not.toBeNull();
  });

  it('a SETTLED thought carries neither — the product is told, it does not sniff text growth', () => {
    const { container } = render(ThoughtPill, { text: 'hmm', label: 'Thought process', live: false });
    expect(container.querySelector('.thought-label')).not.toBeNull();
    expect(container.querySelector('.thought-label.working')).toBeNull();
    expect(container.querySelector('.tl-line.working')).toBeNull();
  });

  it('the SAME nodes settle, so the row cross-fades instead of being rebuilt', async () => {
    const { container, rerender } = render(ThoughtLine, { label: 'thinking…', working: true });
    const label = container.querySelector('.thought-label');
    const line = container.querySelector('.tl-line');
    await rerender({ label: 'thinking…', working: false });
    expect(container.querySelector('.thought-label')).toBe(label);
    expect(container.querySelector('.tl-line')).toBe(line);
    expect(label?.classList.contains('working')).toBe(false);
  });

  it('the line is INSIDE the <summary> — a closed <details> hides every sibling after it', () => {
    // This is the gotcha that cost the mock a whole first attempt: the block
    // starts closed, so a line placed after the summary never renders at all.
    const { container } = render(ThoughtPill, { text: 'hmm', label: 'Thought process', live: true });
    const details = container.querySelector('details.thought-block') as HTMLDetailsElement;
    expect(details.open).toBe(false);
    expect(details.querySelector('summary .tl-line')).not.toBeNull();
  });

  it('the label still carries `mono` for a tool line — the collab pill reads that class', () => {
    const { container } = render(ThoughtPill, { text: '', label: 'read src/x.ts', mono: true });
    expect(container.querySelector('.thought-label')?.classList.contains('mono')).toBe(true);
  });
});

describe('change 23 — the pinned prompt is a fade, not a box', () => {
  const SRC = read('PinnedUserMessage.svelte');

  it('the border, the radius, the shadow and the blur are all gone', () => {
    // Asserted as ABSENCE rather than as `border: 0`: a div has no border to
    // begin with, so declaring one away would be noise standing in for the
    // real claim, which is that this bar draws no frame of any kind. The blur
    // went with them — it had a surface edge to soften, and no longer does.
    expect(SRC).not.toMatch(/border:\s*1px/);
    expect(SRC).not.toMatch(/border-left:/);
    expect(SRC).not.toMatch(/border-radius/);
    expect(SRC).not.toMatch(/box-shadow/);
    expect(SRC).not.toMatch(/backdrop-filter/);
  });

  it('a top-down gradient off --og-surface stands in for the frame', () => {
    expect(SRC).toMatch(/background: linear-gradient\(to bottom,/);
    expect(SRC).toMatch(/--og-surface[^)]*\) 85%, transparent\) 0%, transparent 100%/);
  });

  it('the text is clamped to one line, and expanding lifts the clamp to eight', () => {
    expect(SRC).toMatch(/-webkit-line-clamp: 1;/);
    expect(SRC).toMatch(/\.pinned-user\.expanded \.pinned-text \{ -webkit-line-clamp: 8; \}/);
  });

  it('it still expands on click — losing the box must not cost the control', async () => {
    const { container } = render(PinnedUserMessage, { text: 'a long prompt' });
    const bar = container.querySelector('.pinned-user') as HTMLElement;
    expect(bar.getAttribute('aria-expanded')).toBe('false');
    await fireEvent.click(bar);
    expect(bar.classList.contains('expanded')).toBe(true);
    expect(bar.getAttribute('aria-expanded')).toBe('true');
  });
});
