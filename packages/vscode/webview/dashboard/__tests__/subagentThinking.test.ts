// subagentThinking.test.ts — a sub-agent's LIVE THOUGHT, from the wire to the
// drawer row and the map card (t-gvz8t0).
//
// THE DEFECT. Owner UAT on 0.4.145: "massive lag on the sub agents showing
// their actions, almost as if there was some failure". Nothing was dropped.
// Two `general` children spent their ENTIRE first step reasoning — 123 s for
// 5,449 tokens and 159 s for 7,318 — and the engine forwarded a child's prose
// only, so the drawer row showed NOTHING for two minutes. Silence reads as a
// hang.
//
// WHAT THESE CASES PROTECT, in the order the signal travels: the fold rule
// (a count and the last line, reset by the next prose line), the estimate vs
// the engine's exact figure, the derivation onto the row, the row's own
// markup, and the map card. The end-to-end pane wiring — that thought never
// lands in `taskStream` — is asserted against the real ChatPane, because that
// is the one place the two fields could be confused.

import { describe, expect, it, afterEach } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/svelte';
import { tick } from 'svelte';
import ChatPane from '../panes/ChatPane.svelte';
import SubagentRow from '../components/SubagentRow.svelte';
import {
  appendThinking,
  thinkingLine,
  thinkingNote,
  thinkingRow,
  thinkingTokens,
  THINKING_CAP,
} from '../panes/subagentThinking';
import { subagentRows } from '../panes/subagentRows';
import { mapTree } from '../panes/subagentMapNodes';
import { row, rowProps } from '../panes/subagentRowFixture';

afterEach(() => cleanup());

const T0 = 1_700_000_000_000;

describe('appendThinking — one run of thought', () => {
  it('starts a run on the first delta and keeps that start across every later one', () => {
    const first = appendThinking(undefined, 'weighing ', T0);
    const second = appendThinking(first, 'two approaches', T0 + 30_000);
    expect(second.text).toBe('weighing two approaches');
    // The AGE of the thought is measured from its first delta, not its last.
    expect(second.startedAt).toBe(T0);
    expect(second.chars).toBe('weighing two approaches'.length);
  });

  it('keeps the TAIL past the cap, while the character count keeps counting', () => {
    const big = appendThinking(undefined, 'x'.repeat(THINKING_CAP + 500), T0);
    const next = appendThinking(big, 'LATEST', T0 + 1_000);
    expect(next.text.length).toBe(THINKING_CAP);
    expect(next.text.endsWith('LATEST')).toBe(true);
    // The estimate is derived from `chars`, so dropping the head of the buffer
    // must never make a thought look SMALLER than it already was.
    expect(next.chars).toBe(THINKING_CAP + 500 + 'LATEST'.length);
  });

  it('records the engine reasoning total ONCE, at the start of the run', () => {
    const first = appendThinking(undefined, 'a', T0, 4_000);
    // A later delta carrying a moved total must not shift the baseline under a
    // figure the row has already printed.
    expect(appendThinking(first, 'b', T0 + 500, 9_999).baseReasoning).toBe(4_000);
  });
});

describe('thinkingTokens — measured beats estimated, and says which it is', () => {
  it('estimates from characters while nobody has counted — the measured 2-minute case', () => {
    // No step has finished, so there is no rider at all: this is exactly the
    // first-step window the ticket is about.
    const t = appendThinking(undefined, 'z'.repeat(21_796), T0);
    expect(thinkingTokens(t)).toEqual({ count: 5_449, estimated: true });
    expect(thinkingNote(t, T0 + 123_000)).toBe('thinking · ~5.4k tokens · 2m 03s');
  });

  it('uses the engine figure MINUS the run baseline once one lands', () => {
    const t = appendThinking(undefined, 'z'.repeat(400), T0, 1_000);
    // The rider is a SESSION total; this run's share is the part above the
    // baseline, and it is printed without the tilde because it was measured.
    expect(thinkingTokens(t, { reasoning: 3_400 })).toEqual({ count: 2_400, estimated: false });
    expect(thinkingNote(t, T0 + 5_000, { reasoning: 3_400 })).toBe('thinking · 2.4k tokens · 5s');
  });

  it('falls back to the estimate when the rider has not moved past the baseline', () => {
    const t = appendThinking(undefined, 'zzzz', T0, 3_400);
    // Equal, not greater: this run has been billed nothing yet, and 0 would
    // print as "thinking" with no figure at all.
    expect(thinkingTokens(t, { reasoning: 3_400 })).toEqual({ count: 1, estimated: true });
  });

  it('prints no age until there is one, and no count for an empty thought', () => {
    const t = appendThinking(undefined, '', T0);
    expect(thinkingNote(t, T0)).toBe('thinking');
    expect(thinkingNote(undefined, T0)).toBe('');
  });
});

describe('thinkingLine — the last line of thought', () => {
  it('takes the LAST non-empty line, trimmed', () => {
    const t = appendThinking(undefined, 'first thought\n  second thought  \n\n', T0);
    expect(thinkingLine(t)).toBe('second thought');
  });

  it('is blank for no thought at all, never a fabricated line', () => {
    expect(thinkingLine(undefined)).toBe('');
    expect(thinkingLine(appendThinking(undefined, '\n \n', T0))).toBe('');
  });
});

describe('thinkingRow — a SETTLED child is never thinking', () => {
  it('blanks both halves once the child has stopped', () => {
    const m = { taskThinking: appendThinking(undefined, 'still going', T0) };
    expect(thinkingRow(m, T0 + 1_000, false).thought).toBe('still going');
    // The prose line that clears a thought may never arrive — a child that dies
    // mid-thought sends none — so `settled` has to clear it on its own.
    expect(thinkingRow(m, T0 + 1_000, true)).toEqual({ thinking: '', thought: '' });
  });
});

describe('the drawer row and the map card', () => {
  const card = (over: Record<string, unknown> = {}) => ({
    toolName: 'task',
    taskSessionId: 'ses_child',
    label: 'task',
    toolStatus: 'in_progress',
    taskStartedAt: T0,
    ...over,
  });

  it('derives the heartbeat onto the row, with the activity tail still empty', () => {
    const thinking = appendThinking(undefined, 'z'.repeat(400) + '\nchecking the map', T0);
    const [r] = subagentRows([card({ taskThinking: thinking })], T0 + 62_000);
    expect(r.thinking).toBe('thinking · ~104 tokens · 1m 02s');
    expect(r.thought).toBe('checking the map');
    // The point of the ticket: this is what the row had, and it is empty.
    expect(r.activity).toBe('');
  });

  it('renders the count and the last line on the row, OUTSIDE the fold', () => {
    const { container } = render(SubagentRow, rowProps({
      row: row({ thinking: 'thinking · ~5.4k tokens · 2m 03s', thought: 'weighing two approaches' }),
    }));
    // No click: a reader wondering whether the agent has hung must not have to
    // open a chevron to find out that it has not.
    expect(container.querySelector('.sa-think')?.textContent).toBe('thinking · ~5.4k tokens · 2m 03s');
    expect(container.querySelector('.sa-thought')?.textContent).toBe('weighing two approaches');
  });

  it('shows nothing at all when the child is not thinking', () => {
    const { container } = render(SubagentRow, rowProps({ row: row() }));
    expect(container.querySelector('.sa-think-line')).toBeNull();
  });

  it('puts the count on the map card, in place of a spend that has not moved', () => {
    const [node] = mapTree([row({ thinking: 'thinking · ~5.4k tokens · 2m 03s' })]).nodes;
    expect(node.thinking).toBe('thinking · ~5.4k tokens · 2m 03s');
  });
});

describe('ChatPane wiring — thought is never the child stream', () => {
  const SESSION = 'sess-1';
  const CHILD = 'ses_child_1';
  const post = (data: Record<string, unknown>) => window.dispatchEvent(new MessageEvent('message', { data }));

  async function paneWithTaskCard() {
    render(ChatPane, { props: {} });
    post({ type: 'sessionCreated', sessionId: SESSION, sessionNumber: 1, agentName: 'Tsuru' });
    await tick();
    post({
      type: 'toolCall', sessionId: SESSION, toolCallId: 'call_1', title: 'task', kind: 'think',
      status: 'in_progress', toolName: 'task', taskSessionId: CHILD,
      rawInput: { description: 'write story 1', subagent_type: 'general', prompt: 'go' },
    });
    await tick();
  }

  const think = (text: string) =>
    post({ type: 'subagentThinking', sessionId: SESSION, childSessionId: CHILD, text });

  /** The drawer's own list starts FOLDED (SubagentDrawer.svelte `listOpen`)
   *  unless a running row has already unfolded it (t-ru13hb item 3), so the
   *  header is clicked only while the rows are still out of the DOM. */
  async function openRoster() {
    const head = document.querySelector('.sa-head') as HTMLButtonElement | null;
    expect(head, 'the drawer header must be mounted for a chat with a sub-agent out').not.toBeNull();
    if (!document.querySelector('.sa-groups')) await fireEvent.click(head!);
    await tick();
  }

  it('shows the heartbeat on the drawer row while the child reasons', async () => {
    await paneWithTaskCard();
    think('weighing two approaches');
    await tick();
    await openRoster();
    const line = document.querySelector('.sa-think');
    expect(line, 'the drawer row must show a thinking line').not.toBeNull();
    // 23 characters of thought, estimated at 4 per token and flagged `~`.
    expect(line!.textContent).toMatch(/^thinking · ~6 tokens/);
    expect(document.querySelector('.sa-thought')?.textContent).toBe('weighing two approaches');
  });

  it('never writes the thought into the child stream, and clears it on the first tool line', async () => {
    await paneWithTaskCard();
    think('weighing two approaches');
    await tick();
    post({ type: 'subagentChunk', sessionId: SESSION, childSessionId: CHILD, text: '> read: brief.md\n' });
    await tick();
    await openRoster();

    // The heartbeat is gone: the child stopped weighing and started doing.
    expect(document.querySelector('.sa-think-line')).toBeNull();
    // ...and the row is really on screen, so the assertion above is not passing
    // on an unmounted drawer.
    expect(document.querySelector('.sa-row')).not.toBeNull();
    // And the thought is nowhere in the stream the card and the row read from.
    expect(document.body.textContent ?? '').not.toContain('weighing two approaches');
  });

  it('drops a thought for a child nobody has a card for, rather than dumping it in the chat', async () => {
    await paneWithTaskCard();
    post({ type: 'subagentThinking', sessionId: SESSION, childSessionId: 'ses_stranger', text: 'stray thought' });
    await tick();
    expect(document.body.textContent ?? '').not.toContain('stray thought');
  });
});
