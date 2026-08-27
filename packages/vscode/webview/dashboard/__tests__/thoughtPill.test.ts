// ThoughtPill — the reasoning block shared by the chat transcript and the
// collab stream. Two surfaces drawing "a model is thinking" must not drift
// into two different objects, so the properties asserted here are the ones
// both depend on.
//
// The load-bearing rule is the one thoughtCollapsed.test.ts already guards on
// the chat side: it renders CLOSED even while live. A pill that opens itself
// throws a wall of reasoning over whatever the user was reading.

import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/svelte';
import ThoughtPill from '../components/ThoughtPill.svelte';

const mount = (props: Record<string, unknown>) =>
  render(ThoughtPill, { text: '', label: '', ...props });

afterEach(() => cleanup());

describe('ThoughtPill — live and settled are the same block, differently tinted', () => {
  it('a LIVE pill is marked live and still renders collapsed', () => {
    const { container } = mount({ text: 'weighing it up', label: 'Thought process', live: true });
    const details = container.querySelector('details.thought-block') as HTMLDetailsElement;
    expect(details.classList.contains('live')).toBe(true);
    expect(details.open).toBe(false);
  });

  it('a SETTLED pill carries no live class — the tint reverts when the turn ends', () => {
    const { container } = mount({ text: 'weighing it up', label: 'Thought process' });
    expect(container.querySelector('details.thought-block')!.classList.contains('live')).toBe(false);
  });
});

describe('ThoughtPill — it stays expandable, and its text survives intact', () => {
  it('keeps a summary to click and the full body behind it', () => {
    const { container } = mount({ text: 'line one\nline two', label: 'Thought process' });
    const details = container.querySelector('details.thought-block')!;
    expect(details.querySelector('summary')).not.toBeNull();
    // A <pre>: line breaks in a reasoning burst are information, not noise.
    expect(details.querySelector('.thought-text')!.textContent).toBe('line one\nline two');
  });

  it('renders the label it was given, verbatim', () => {
    const { container } = mount({ text: 'x', label: 'read src/parser.ts' });
    expect(container.querySelector('.thought-label')!.textContent).toBe('read src/parser.ts');
  });
});

describe('ThoughtPill — a tool line is set as code, prose is not', () => {
  it('mono marks the LABEL, which is the only place the two differ', () => {
    const { container } = mount({ text: 'x', label: 'grep -n foo src/', mono: true });
    expect(container.querySelector('.thought-label')!.classList.contains('mono')).toBe(true);
  });

  it('prose gets no mono class', () => {
    const { container } = mount({ text: 'x', label: 'Thought process' });
    expect(container.querySelector('.thought-label')!.classList.contains('mono')).toBe(false);
  });
});

describe('ThoughtPill — the default mark is the chat brain', () => {
  it('renders the brain when no mark snippet is supplied', () => {
    // The chat's rotating crane lives on its stream indicator; a second one
    // here would run out of phase with it, so this stays static.
    const { container } = mount({ text: 'x', label: 'Thought process' });
    expect(container.querySelector('.thought-brain')).not.toBeNull();
  });
});

describe('ThoughtPill — an empty body is empty, never filled in', () => {
  it('renders no text rather than a placeholder the model never produced', () => {
    const { container } = mount({ text: '', label: 'thinking…' });
    expect(container.querySelector('.thought-text')!.textContent).toBe('');
  });
});
