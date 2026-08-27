// The per-agent context drawer — W2, report F14 + the wave-1 activity log.
//
// TWO defects, one surface.
//
//   F14: THE DRAWER WAS A ONE-SHOT FETCH. `openContext` posted a single
//   `collabPromptCapture` and nothing ever asked again, so a drawer left open
//   beside a working agent showed the prompt that agent had ten minutes and four
//   tool calls ago — with no indication it was stale. A drawer that is open is a
//   drawer being read; it re-asks while it is.
//
//   THE ACTIVITY LOG HAD NOWHERE TO LAND. Wave 1 shipped per-agent retention
//   engine-side (`collab/activity.ts`, last 20 kept ACROSS turns) precisely
//   because a chip showing only the newest line makes a room look like it is
//   thinking rather than working (report F3). Nothing extension-side mirrored the
//   field, so it arrived and was dropped. It belongs beside the prompt capture:
//   both answer "what has this agent actually been doing".
//
// The log is rendered for an IDLE agent too. That is the point of retention —
// `liveActivity` answers "what is it doing"; a room between turns answers that
// with nothing at all, and the last few things it did is the honest substitute.

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, cleanup } from '@testing-library/svelte';
import CollabContextDrawer from './CollabContextDrawer.svelte';
import type { CollabActivityEntry } from '../../src/acpExtTypes';

const entry = (over: Partial<CollabActivityEntry> = {}): CollabActivityEntry => ({
  kind: 'tool', text: 'read src/parser.ts', messageId: 'm1', ...over,
});

const base = {
  slug: 'collab-crane',
  name: 'Crane',
  hasSession: true,
  capture: null,
  captureError: null,
  captureLoaded: true,
  onClose: () => {},
};

const mount = (props: Record<string, unknown> = {}) => render(CollabContextDrawer, { ...base, ...props });
const rows = (c: Element) => Array.from(c.querySelectorAll('.ctx-act-row'));
const flat = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();

afterEach(() => cleanup());

describe('CollabContextDrawer — the retained activity log', () => {
  it('lists what the agent has been doing, newest first', () => {
    const { container } = mount({
      activity: [
        entry({ kind: 'thought', text: 'the printer is the risk' }),
        entry({ kind: 'tool', text: 'read src/printer.ts' }),
      ],
    });
    expect(rows(container)).toHaveLength(2);
    expect(flat(rows(container)[0].textContent)).toContain('read src/printer.ts');
    expect(flat(rows(container)[1].textContent)).toContain('the printer is the risk');
  });

  it('says which of the two kinds each line was — a tool call is not a thought', () => {
    const { container } = mount({ activity: [entry({ kind: 'tool', text: 'grep parse' })] });
    expect(flat(rows(container)[0].textContent)).toContain('tool');
  });

  // The engine keeps 20 across turns. All twenty in a drawer would bury the
  // prompt capture underneath them; the newest handful is what a glance needs.
  it('shows only the newest few, however many the engine retained', () => {
    const { container } = mount({
      activity: Array.from({ length: 20 }, (_, i) => entry({ text: `step ${i}`, messageId: `m${i}` })),
    });
    expect(rows(container).length).toBeLessThanOrEqual(5);
    expect(flat(rows(container)[0].textContent)).toContain('step 19');
  });

  // ABSENT is an older engine, EMPTY is an agent that has done nothing yet.
  // Neither may render as the other, and neither may render as an error.
  it('an engine that sends no log at all says so, rather than showing nothing', () => {
    const { container } = mount({});
    expect(rows(container)).toHaveLength(0);
    expect(flat(container.textContent)).toContain('No activity');
  });

  it('an empty log is the same honest line, never a fabricated row', () => {
    const { container } = mount({ activity: [] });
    expect(rows(container)).toHaveLength(0);
    expect(flat(container.textContent)).toContain('No activity');
  });
});

describe('CollabContextDrawer — it does not go stale while you read it (F14)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('re-asks for the capture while it is open', () => {
    const onRefresh = vi.fn();
    mount({ onRefresh });
    expect(onRefresh).not.toHaveBeenCalled(); // the OPEN already fetched once

    vi.advanceTimersByTime(4000);
    expect(onRefresh).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(4000);
    expect(onRefresh).toHaveBeenCalledTimes(2);
  });

  // The drawer is mounted only while an agent's context is open, so closing it
  // must take the timer with it — a poll behind a closed drawer is a round trip
  // nobody will ever see the answer to.
  it('stops the moment the drawer closes', () => {
    const onRefresh = vi.fn();
    const { unmount } = mount({ onRefresh });
    vi.advanceTimersByTime(4000);
    expect(onRefresh).toHaveBeenCalledTimes(1);

    unmount();
    vi.advanceTimersByTime(12000);
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it('a caller that wires no refresh keeps today behaviour, and never throws', () => {
    expect(() => {
      mount({});
      vi.advanceTimersByTime(12000);
    }).not.toThrow();
  });
});
