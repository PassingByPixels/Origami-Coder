// SubagentRow.test.ts — the per-row collapse toggle (t-kgryh1 round 2).
//
// TEST GAP this file closes (fix round, verifier-confirmed): the chevron
// button and its `expanded` $state landed with NO test rendering the
// component and driving the toggle — subagentRows.test.ts covers the row
// DATA (subagentRows.ts), never the .svelte control. Direct-render precedent
// is TodoStrip.test.ts (same folder): render the leaf component with props,
// fireEvent.click its fold control, assert aria-expanded and content
// show/hide, same shape CollabTaskDrawer.test.ts uses one level up.

import { render, screen, fireEvent, cleanup } from '@testing-library/svelte';
import { describe, expect, it, vi, afterEach } from 'vitest';
import SubagentRow from './SubagentRow.svelte';
import type { SubagentRow as SubagentRowT } from '../panes/subagentRows';

afterEach(() => cleanup());

const row = (over: Partial<SubagentRowT> = {}): SubagentRowT => ({
  key: 'tc-1',
  title: 'Worker-crane',
  state: 'running',
  elapsedMs: 5000,
  activity: 'reading file.ts',
  stream: 'reading file.ts\nwriting file.ts',
  ...over,
});

const fold = (c: HTMLElement) => c.querySelector('.sa-fold') as HTMLButtonElement;
const activity = (c: HTMLElement) => c.querySelector('.sa-activity');

describe('SubagentRow — per-row collapse', () => {
  it('starts expanded: activity shown, fold button reports aria-expanded=true, chevron down', () => {
    const { container } = render(SubagentRow, {
      props: { row: row(), onDismiss: vi.fn(), onOpenInTab: vi.fn() },
    });
    expect(activity(container)?.textContent).toBe('reading file.ts');
    expect(fold(container).getAttribute('aria-expanded')).toBe('true');
    expect(fold(container).textContent).toBe('▾'); // ▾
  });

  it('clicking the fold hides only the activity tail — the header line (name) stays', async () => {
    const { container } = render(SubagentRow, {
      props: { row: row(), onDismiss: vi.fn(), onOpenInTab: vi.fn() },
    });
    await fireEvent.click(fold(container));

    expect(activity(container)).toBeNull();
    expect(fold(container).getAttribute('aria-expanded')).toBe('false');
    expect(fold(container).textContent).toBe('▸'); // ▸
    expect(screen.getByText('Worker-crane')).toBeInTheDocument();
  });

  it('clicking again reopens — the activity text was never discarded, just re-derived from the row', async () => {
    const { container } = render(SubagentRow, {
      props: { row: row(), onDismiss: vi.fn(), onOpenInTab: vi.fn() },
    });
    await fireEvent.click(fold(container));
    expect(activity(container)).toBeNull();

    await fireEvent.click(fold(container));
    expect(activity(container)?.textContent).toBe('reading file.ts');
    expect(fold(container).getAttribute('aria-expanded')).toBe('true');
  });

  it('a silent row (no activity) renders no fold button at all — nothing to collapse', () => {
    const { container } = render(SubagentRow, {
      props: { row: row({ activity: '' }), onDismiss: vi.fn(), onOpenInTab: vi.fn() },
    });
    expect(container.querySelector('.sa-fold')).toBeNull();
  });
});
