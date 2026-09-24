// Origami U1 — component render tests (Origami-native fixtures).
//
// SUPERSEDES the plan's "render parity vs donor recorded fixtures"
// test (04/U1). Per the hard rule, NO donor fixtures are imported —
// importing them would assert the deleted `_meta.lilinyx_kind` /
// `nyx/*` / Diarchy surface. Instead we author small FRESH fixtures
// in the NEW `origami/*` shape and assert the KEPT components render
// them. This honours U1's intent (catch an accidental edit during the
// component lift) while testing the surface we actually ship.

import { render, screen, fireEvent } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import TodoStrip from './TodoStrip.svelte';
import ToolCard from './ToolCard.svelte';

const post = () => globalThis.__vscodeApiMock.postMessage;

describe('TodoStrip ← origami/todoSnapshot fixture', () => {
  it('renders each todo content and the done count', () => {
    // Fresh fixture in the origami/todoSnapshot payload shape.
    const todos = [
      { id: 1, content: 'Parse the wire', activeForm: 'Parsing the wire', status: 'completed' as const },
      { id: 2, content: 'Decode events', activeForm: 'Decoding events', status: 'in_progress' as const },
      { id: 3, content: 'Render strip', activeForm: 'Rendering strip', status: 'pending' as const },
    ];
    render(TodoStrip, { todos, source: 'model_write' });
    expect(screen.getByText('Parse the wire')).toBeInTheDocument();
    expect(screen.getByText('Decode events')).toBeInTheDocument();
    expect(screen.getByText('Render strip')).toBeInTheDocument();
    // 1 of 3 completed.
    expect(screen.getByText(/1\/3 done/)).toBeInTheDocument();
  });

  it('shows the empty state when no todos have landed', () => {
    render(TodoStrip, { todos: [], source: '' });
    expect(screen.getByText(/none yet/i)).toBeInTheDocument();
  });
});

describe('ToolCard ← origami ToolCall fixture (lilinyx_tool_name decoration)', () => {
  it('renders the tool title and routes a known tool name to a specialised card', () => {
    // Fresh fixture: a real ToolCall decorated with the kept wire key's
    // value (toolName), as the bridge supplies it.
    render(ToolCard, {
      title: 'grep "wireMethod" src/',
      kind: 'search',
      toolName: 'grep',
      status: 'completed',
      result: 'src/acpClient.ts:1',
    });
    expect(screen.getByText('grep "wireMethod" src/')).toBeInTheDocument();
  });

  it('falls back to GenericCard for an unknown / absent tool name', () => {
    render(ToolCard, {
      title: 'mystery tool',
      kind: 'other',
      toolName: '',
      status: 'completed',
      result: 'done',
    });
    // The frame still renders the title regardless of which body card
    // is chosen — proving the dispatcher didn't crash on an unknown name.
    expect(screen.getByText('mystery tool')).toBeInTheDocument();
  });

  function renderReadCard() {
    post().mockReset();
    const { container } = render(ToolCard, {
      title: 'read.ts',
      kind: 'read',
      toolName: 'read',
      status: 'completed',
      path: 'src/tool/read.ts',
      result: 'file body',
      toolLines: { start: 26, end: 61 },
    });
    return container;
  }

  it('shows the actual read range as a suffix, and clicking the path reveals the file', async () => {
    // t-qmzegs item 5 (CHANGES.md 46): the header path reveals the file in the
    // OS explorer and no longer opens an editor tab at `toolLines.start`.
    // THE LINE JUMP IS GONE WITH IT — the range is still shown, but nothing on
    // the card now navigates to it. That is a deliberate consequence of the
    // round-3 decision, not an oversight, and it is flagged for the owner.
    renderReadCard();
    expect(screen.getByText('(lines 26-61)')).toBeInTheDocument();
    const pathEl = document.querySelector('[data-tip="Reveal src/tool/read.ts in the file explorer"]') as HTMLElement;
    expect(pathEl).toHaveTextContent('src/tool/read.ts');

    await fireEvent.click(pathEl);
    expect(post()).toHaveBeenCalledWith({
      type: 'revealInExplorer',
      path: 'src/tool/read.ts',
    });
  });

  it('renders the range as its own chip, with no whitespace of its own', () => {
    // A direct element read, NOT getByText: that query normalises whitespace and
    // so cannot tell " (lines 26-61)" from "(lines 26-61)". The exact string
    // matters because a source-level leading space here is a LIE — svelte trims
    // it at compile time, and the header's flex gap is what separates the chip
    // from the path. Anyone re-adding one would be styling with dead characters.
    const container = renderReadCard();
    expect(container.querySelector('.tool-lines')?.textContent).toBe('(lines 26-61)');
  });

  it('the header carries THREE controls that do three different things', async () => {
    // The suffix used to be inert, bubbling to the header so a click on it only
    // toggled the card. t-qmzegs reversed that on the owner's ruling: the range
    // is the control that opens the file AT its line, which is the capability
    // the path lost when the path became a reveal. So the header now holds
    // three separate jobs, and this asserts they stay separate — the failure
    // this guards is one click doing two of them.
    const container = renderReadCard();
    const lines = container.querySelector('.tool-lines') as HTMLElement;

    await fireEvent.click(lines);
    expect(post().mock.calls.map((c) => c[0])).toEqual([
      { type: 'openAbsoluteFile', path: 'src/tool/read.ts', line: 26 },
    ]);
    // ...and it does NOT also toggle the card, the way an inert suffix did.
    expect(container.querySelector('.expand-arrow.open')).toBeNull();

    // The title is still the expand control, and posts nothing.
    post().mockClear();
    await fireEvent.click(container.querySelector('.tool-title') as HTMLElement);
    expect(post()).not.toHaveBeenCalled();
    expect(container.querySelector('.expand-arrow.open')).not.toBeNull();
  });
});
