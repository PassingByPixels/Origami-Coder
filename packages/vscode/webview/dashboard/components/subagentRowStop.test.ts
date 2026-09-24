// subagentRowStop.test.ts — t-q910fo: the per-row Stop control.
//
// WHICH row gets one is the whole question. A Stop over a settled child would
// address a job that no longer exists, and a Stop over a spawn that never
// reached a session has no id to send — both would be a button that does
// nothing, which is worse than no button.
//
// The ACT is asserted at the row's edge (the handler is called with THAT row),
// not by spying on the wire: SubagentDock.svelte owns the post, and a test that
// re-stated its message shape here would assert a copy of the implementation.
import { render, fireEvent, cleanup } from '@testing-library/svelte';
import { describe, expect, it, afterEach, vi } from 'vitest';
import SubagentRow from './SubagentRow.svelte';
import { row, rowProps } from '../panes/subagentRowFixture';

afterEach(() => cleanup());

const stop = (c: HTMLElement) => c.querySelector('.sa-stop') as HTMLButtonElement | null;

describe('SubagentRow — Stop (t-q910fo)', () => {
  it('a RUNNING child with a session gets a Stop, named for that agent', () => {
    const { container } = render(
      SubagentRow,
      rowProps({ row: row({ description: 'audit the bundle' }), onStop: () => {} }),
    );
    expect(stop(container)?.textContent).toBe('Stop');
    expect(stop(container)?.getAttribute('aria-label')).toBe('Stop T1 · audit the bundle');
  });

  it('pressing it hands back THAT row — and asks nothing first', async () => {
    const onStop = vi.fn();
    const target = row({ key: 'child-7', taskSessionId: 'ses_child_7' });
    const { container } = render(SubagentRow, rowProps({ row: target, onStop }));

    await fireEvent.click(stop(container)!);

    expect(onStop).toHaveBeenCalledTimes(1);
    expect(onStop.mock.calls[0][0].taskSessionId).toBe('ses_child_7');
  });

  it('a SETTLED child has none — there is no job left to abort', () => {
    const { container } = render(
      SubagentRow,
      rowProps({ row: row({ state: 'done', settled: true }), onStop: () => {} }),
    );
    expect(stop(container)).toBeNull();
  });

  it('a running spawn that never reached a session has none — nothing to address', () => {
    const bare = row();
    delete bare.taskSessionId;
    const { container } = render(SubagentRow, rowProps({ row: bare, onStop: () => {} }));
    expect(stop(container)).toBeNull();
  });

  it('a surface that passes no onStop draws no Stop — a read-only row is not a control panel', () => {
    const { container } = render(SubagentRow, rowProps({ row: row() }));
    expect(stop(container)).toBeNull();
  });
});
