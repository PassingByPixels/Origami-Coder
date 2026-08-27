// InstructionRowActions — the "Restore default" button on the two
// Instructions-pane rows that have a known default: the base prompt once
// overridden, and the project AGENTS.md. The bugs worth catching: the pure
// visibility rule picking a row it should not (a global file, a project
// CLAUDE.md/CONTEXT.md, a built-in base prompt with nothing to restore), and
// a click that leaks into the row's own open-file handler instead of being
// contained to the button.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/svelte';
import InstructionRowActions, { restoreKindFor } from '../components/InstructionRowActions.svelte';

beforeEach(() => { globalThis.__vscodeApiMock.postMessage.mockClear(); });
afterEach(() => cleanup());

describe('restoreKindFor — pure rule for which row gets the button', () => {
  it('the overridden base prompt gets "base-prompt"', () => {
    expect(restoreKindFor({ source: 'base-prompt', path: 'C:\\ws\\base-prompt.md', overridden: true })).toBe('base-prompt');
  });

  it('the built-in base prompt (not overridden) gets nothing — there is nothing to restore', () => {
    expect(restoreKindFor({ source: 'base-prompt', path: 'C:\\ws\\base-prompt.md', overridden: false })).toBeNull();
    expect(restoreKindFor({ source: 'base-prompt', path: 'C:\\ws\\base-prompt.md' })).toBeNull();
  });

  it('the collab row restores its OWN file, never the base prompt', () => {
    // Folding this into 'base-prompt' would delete the wrong file — the same
    // button on two rows has to name two different defaults.
    expect(restoreKindFor({ source: 'collab-agent-base', path: 'C:\\ws\\collab-agent-base.md', overridden: true })).toBe('collab-agent-base');
  });

  it('a built-in collab row gets nothing either — it IS the default', () => {
    expect(restoreKindFor({ source: 'collab-agent-base', path: 'C:\\ws\\collab-agent-base.md' })).toBeNull();
  });

  it('the RETIRED collab-manual source gets nothing, even marked overridden', () => {
    // M4.1 merged the room manual away. The host resolves no file for that
    // kind any more, so offering the button would be a control that errors.
    expect(restoreKindFor({ source: 'collab-manual', path: 'C:\\ws\\collab-base.md', overridden: true })).toBeNull();
  });

  it('a project AGENTS.md gets "agents-md"', () => {
    expect(restoreKindFor({ source: 'project', path: 'C:\\ws\\AGENTS.md' })).toBe('agents-md');
    expect(restoreKindFor({ source: 'project', path: '/home/p/ws/AGENTS.md' })).toBe('agents-md');
  });

  it('a project CLAUDE.md or CONTEXT.md gets nothing — no known default for those', () => {
    expect(restoreKindFor({ source: 'project', path: 'C:\\ws\\CLAUDE.md' })).toBeNull();
    expect(restoreKindFor({ source: 'project', path: 'C:\\ws\\CONTEXT.md' })).toBeNull();
  });

  it('a GLOBAL AGENTS.md gets nothing — only the project-level row has a default', () => {
    expect(restoreKindFor({ source: 'global', path: 'C:\\Users\\p\\.config\\origami\\AGENTS.md' })).toBeNull();
  });

  it('memory, config and url entries get nothing', () => {
    expect(restoreKindFor({ source: 'memory', path: 'C:\\ws\\.origami\\memory.md' })).toBeNull();
    expect(restoreKindFor({ source: 'config', path: 'C:\\ws\\house-style.md' })).toBeNull();
    expect(restoreKindFor({ source: 'url', path: 'https://example.com/x.md' })).toBeNull();
  });
});

describe('InstructionRowActions — the button', () => {
  it('renders "Restore default"', () => {
    const { getByRole } = render(InstructionRowActions, { kind: 'agents-md' });
    expect(getByRole('button', { name: 'Restore default' })).toBeInTheDocument();
  });

  it('clicking posts restoreInstructionDefault with the given kind', async () => {
    const { getByRole } = render(InstructionRowActions, { kind: 'base-prompt' });
    await fireEvent.click(getByRole('button', { name: 'Restore default' }));
    const posts = globalThis.__vscodeApiMock.postMessage.mock.calls.map((c: unknown[]) => c[0]);
    expect(posts).toContainEqual({ type: 'restoreInstructionDefault', kind: 'base-prompt' });
  });

  it('the agents-md kind is posted verbatim, not folded into base-prompt', async () => {
    const { getByRole } = render(InstructionRowActions, { kind: 'agents-md' });
    await fireEvent.click(getByRole('button', { name: 'Restore default' }));
    const posts = globalThis.__vscodeApiMock.postMessage.mock.calls.map((c: unknown[]) => c[0]);
    expect(posts).toContainEqual({ type: 'restoreInstructionDefault', kind: 'agents-md' });
  });

  it('a collab kind is posted verbatim too — the host deletes a different file for each', async () => {
    const { getByRole } = render(InstructionRowActions, { kind: 'collab-agent-base' });
    await fireEvent.click(getByRole('button', { name: 'Restore default' }));
    const posts = globalThis.__vscodeApiMock.postMessage.mock.calls.map((c: unknown[]) => c[0]);
    expect(posts).toContainEqual({ type: 'restoreInstructionDefault', kind: 'collab-agent-base' });
  });

  // stopPropagation (the click must not also open the row's file) is proven
  // at the REAL nesting site instead of here: Svelte 5 delegates onclick
  // through a single root listener, so a bare `addEventListener` ancestor in
  // an isolated test does not reproduce how two Svelte onclick handlers
  // actually interact — only mounting inside the real row does. See
  // instructionsPane.test.ts: "clicking it posts restoreInstructionDefault,
  // never the row-open message".
});
