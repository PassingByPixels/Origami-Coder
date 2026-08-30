// chatFocus.test.ts — the focus-view rule, with no DOM around it.
//
// The dispositions are the whole feature: everything else (an eye button, a
// filtered {#each}) is plumbing that either calls this or does not. So every
// kind ChatTranscript.svelte dispatches on is named here EXPLICITLY rather
// than checked in a loop over the set — a loop over HIDDEN_IN_FOCUS would
// re-assert the implementation and pass whatever the set happened to contain.
//
// The kind list is derived from the dispatch chain in ChatTranscript.svelte
// and the `kind` union in panes/chatMessage.ts, read on 2026-08-28.

import { describe, expect, it } from 'vitest';
import { visibleInFocus } from './chatFocus';
import type { Message } from '../panes/chatMessage';

/** A real row of each kind, so the predicate is exercised with the shape the
 *  transcript actually hands it and not a bare `{ kind }` literal. */
function row(kind: Message['kind'], extra: Partial<Message> = {}): Message {
  return { id: 1, kind, label: '', text: '', ...extra };
}

describe('visibleInFocus — the conversation stays', () => {
  it('keeps the user’s own words', () => {
    expect(visibleInFocus(row('user', { label: 'You', text: 'ship it' }))).toBe(true);
  });

  it('keeps the model’s answer', () => {
    expect(visibleInFocus(row('agent', { label: 'Tsuru', text: 'shipped' }))).toBe(true);
  });

  it('keeps a PEER’s prose — in a collab chat those replies are the conversation', () => {
    expect(visibleInFocus(row('peer', { label: 'Kirin', peerReplyTo: 'Tsuru' }))).toBe(true);
  });

  it('keeps a system row — host prose with nowhere else to land', () => {
    expect(visibleInFocus(row('system'))).toBe(true);
  });

  it('keeps an ERROR row: when a turn fails, the failure is the answer', () => {
    expect(visibleInFocus(row('error', { text: 'model refused' }))).toBe(true);
  });
});

describe('visibleInFocus — the reasoning and the machinery go', () => {
  it('drops tool cards', () => {
    expect(visibleInFocus(row('tool', { toolName: 'read_file', toolStatus: 'completed' }))).toBe(false);
  });

  it('drops reasoning blocks', () => {
    expect(visibleInFocus(row('thought', { text: 'weighing the boundary' }))).toBe(false);
  });

  it('drops the inline todo snapshot', () => {
    expect(visibleInFocus(row('todoSummary', {
      summaryTodos: [{ id: 1, content: 'extract', activeForm: 'extracting', status: 'completed' }],
    }))).toBe(false);
  });

  it('drops the per-turn verdict', () => {
    expect(visibleInFocus(row('verdict', { verdict: { kind: 'done', reason: 'success' } }))).toBe(false);
  });

  it('drops a verdict row BY KIND even with no verdict payload', () => {
    // Such a row falls through to a plain MessageRow in the transcript, which
    // is exactly why the rule cannot key off the payload: it would leak turn
    // bookkeeping into the conversation through the default branch.
    expect(visibleInFocus(row('verdict'))).toBe(false);
  });

  it('drops the compaction marker', () => {
    expect(visibleInFocus(row('compacted', { compacting: false }))).toBe(false);
  });
});

describe('visibleInFocus — fail open', () => {
  it('shows a kind it has never heard of', () => {
    // No cast: the parameter is `{ kind: string }` precisely so this case can
    // be a real one. A message type added next year must appear until somebody
    // decides it should not — a view that silently swallows new rows is a
    // defect with no symptom.
    expect(visibleInFocus({ kind: 'handoff' })).toBe(true);
    expect(visibleInFocus({ kind: '' })).toBe(true);
  });

  it('is case- and shape-exact: near misses of a hidden kind still show', () => {
    // Guards a rename landing on one side only (e.g. 'todoSummary' becoming
    // 'todo_summary'): the row reappears rather than vanishing silently.
    expect(visibleInFocus({ kind: 'Tool' })).toBe(true);
    expect(visibleInFocus({ kind: 'todo_summary' })).toBe(true);
  });
});
